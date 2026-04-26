using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;

public class GoogleTokenValidator(HttpClient httpClient, IConfiguration configuration)
{
    private const string GoogleIssuer = "https://accounts.google.com";
    private const string GoogleIssuerShort = "accounts.google.com";
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public async Task<string?> ExchangeAuthorizationCodeAsync(string code, string redirectUri)
    {
        var clientId = configuration["Authentication:Google:ClientId"];
        var clientSecret = configuration["Authentication:Google:ClientSecret"];
        if (string.IsNullOrWhiteSpace(clientId) || string.IsNullOrWhiteSpace(clientSecret))
        {
            return null;
        }

        using var content = new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["code"] = code,
            ["client_id"] = clientId,
            ["client_secret"] = clientSecret,
            ["redirect_uri"] = redirectUri,
            ["grant_type"] = "authorization_code"
        });

        using var response = await httpClient.PostAsync("https://oauth2.googleapis.com/token", content);
        if (!response.IsSuccessStatusCode)
        {
            return null;
        }

        await using var stream = await response.Content.ReadAsStreamAsync();
        var tokenResponse = await JsonSerializer.DeserializeAsync<GoogleTokenResponse>(stream, JsonOptions);
        return tokenResponse?.IdToken;
    }

    public async Task<GooglePayload?> ValidateAsync(string credential)
    {
        var clientId = configuration["Authentication:Google:ClientId"];
        if (string.IsNullOrWhiteSpace(clientId) || string.IsNullOrWhiteSpace(credential))
        {
            return null;
        }

        var parts = credential.Split('.');
        if (parts.Length != 3)
        {
            return null;
        }

        using var header = JsonDocument.Parse(Base64UrlDecode(parts[0]));
        var kid = header.RootElement.GetProperty("kid").GetString();
        var algorithm = header.RootElement.GetProperty("alg").GetString();
        if (string.IsNullOrWhiteSpace(kid) || algorithm != "RS256")
        {
            return null;
        }

        var key = await FindGoogleKeyAsync(kid);
        if (key is null)
        {
            return null;
        }

        var signedBytes = System.Text.Encoding.ASCII.GetBytes($"{parts[0]}.{parts[1]}");
        var signatureBytes = Base64UrlDecode(parts[2]);
        using var rsa = RSA.Create();
        rsa.ImportParameters(key.Value);
        var signatureValid = rsa.VerifyData(signedBytes, signatureBytes, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        if (!signatureValid)
        {
            return null;
        }

        using var payload = JsonDocument.Parse(Base64UrlDecode(parts[1]));
        var root = payload.RootElement;
        var audience = root.GetProperty("aud").GetString();
        var issuer = root.GetProperty("iss").GetString();
        var expiresAt = root.GetProperty("exp").GetInt64();
        var subject = root.GetProperty("sub").GetString();
        var email = root.TryGetProperty("email", out var emailElement) ? emailElement.GetString() : null;
        var name = root.TryGetProperty("name", out var nameElement) ? nameElement.GetString() : email;

        var expired = DateTimeOffset.FromUnixTimeSeconds(expiresAt) <= DateTimeOffset.UtcNow;
        if (audience != clientId || (issuer != GoogleIssuer && issuer != GoogleIssuerShort) || expired ||
            string.IsNullOrWhiteSpace(subject) || string.IsNullOrWhiteSpace(email))
        {
            return null;
        }

        return new GooglePayload(subject, email, name ?? email);
    }

    private async Task<RSAParameters?> FindGoogleKeyAsync(string kid)
    {
        using var response = await httpClient.GetAsync("https://www.googleapis.com/oauth2/v3/certs");
        if (!response.IsSuccessStatusCode)
        {
            return null;
        }

        await using var stream = await response.Content.ReadAsStreamAsync();
        var document = await JsonSerializer.DeserializeAsync<JsonWebKeySet>(stream, JsonOptions);
        var key = document?.Keys.FirstOrDefault(candidate => candidate.Kid == kid && candidate.Kty == "RSA");
        if (key is null)
        {
            return null;
        }

        return new RSAParameters
        {
            Modulus = Base64UrlDecode(key.N),
            Exponent = Base64UrlDecode(key.E)
        };
    }

    private static byte[] Base64UrlDecode(string value)
    {
        var base64 = value.Replace('-', '+').Replace('_', '/');
        base64 = base64.PadRight(base64.Length + (4 - base64.Length % 4) % 4, '=');
        return Convert.FromBase64String(base64);
    }

    private record JsonWebKeySet(List<JsonWebKey> Keys);

    private record JsonWebKey(string Kid, string Kty, string N, string E);

    private record GoogleTokenResponse([property: JsonPropertyName("id_token")] string IdToken);
}
