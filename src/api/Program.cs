using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddCors(options =>
{
    options.AddDefaultPolicy(policy =>
        policy.WithOrigins("http://localhost:4200")
            .AllowAnyHeader()
            .AllowAnyMethod());
});
builder.Services.AddSingleton<AppStore>();
builder.Services.AddHttpClient<GoogleTokenValidator>();
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen();

var app = builder.Build();

if (app.Environment.IsDevelopment())
{
    app.UseSwagger();
    app.UseSwaggerUI();
}

app.UseCors();

var api = app.MapGroup("/api");

api.MapGet("/config", (IConfiguration configuration) =>
{
    var clientId = configuration["Authentication:Google:ClientId"] ?? "";
    var clientSecret = configuration["Authentication:Google:ClientSecret"] ?? "";
    return Results.Ok(new PublicConfig(clientId, !string.IsNullOrWhiteSpace(clientId) && !string.IsNullOrWhiteSpace(clientSecret)));
});

api.MapPost("/auth/register", async (AuthRequest request, AppStore store) =>
{
    if (string.IsNullOrWhiteSpace(request.Email) || string.IsNullOrWhiteSpace(request.Password))
    {
        return Results.BadRequest(new ApiError("Email and password are required."));
    }

    if (request.Password.Length < 6)
    {
        return Results.BadRequest(new ApiError("Password must be at least 6 characters."));
    }

    var normalizedEmail = request.Email.Trim().ToLowerInvariant();
    var state = await store.LoadAsync();

    if (state.Users.Any(user => user.Email == normalizedEmail))
    {
        return Results.Conflict(new ApiError("This email is already registered."));
    }

    var user = UserRecord.Create(request.Name?.Trim(), normalizedEmail, request.Password);
    var token = SessionRecord.Create(user.Id);

    state.Users.Add(user);
    state.Sessions.Add(token);
    await store.SaveAsync(state);

    return Results.Ok(AuthResponse.From(user, token.Token));
});

api.MapPost("/auth/login", async (AuthRequest request, AppStore store) =>
{
    var normalizedEmail = request.Email.Trim().ToLowerInvariant();
    var state = await store.LoadAsync();
    var user = state.Users.FirstOrDefault(candidate => candidate.Email == normalizedEmail);

    if (user is null || !user.VerifyPassword(request.Password))
    {
        return Results.Unauthorized();
    }

    var token = SessionRecord.Create(user.Id);
    state.Sessions.Add(token);
    await store.SaveAsync(state);

    return Results.Ok(AuthResponse.From(user, token.Token));
});

api.MapPost("/auth/google", async (GoogleAuthRequest request, GoogleTokenValidator validator, AppStore store) =>
{
    var payload = await validator.ValidateAsync(request.Credential);
    if (payload is null)
    {
        return Results.BadRequest(new ApiError("Google sign-in is not configured or the token is invalid."));
    }

    var normalizedEmail = payload.Email.Trim().ToLowerInvariant();
    var state = await store.LoadAsync();
    var user = state.Users.FirstOrDefault(candidate => candidate.GoogleSubject == payload.Subject)
        ?? state.Users.FirstOrDefault(candidate => candidate.Email == normalizedEmail);

    if (user is null)
    {
        user = UserRecord.CreateGoogle(payload.Name, normalizedEmail, payload.Subject);
        state.Users.Add(user);
    }
    else
    {
        user.GoogleSubject = payload.Subject;
        user.Name = string.IsNullOrWhiteSpace(user.Name) ? payload.Name : user.Name;
    }

    var token = SessionRecord.Create(user.Id);
    state.Sessions.Add(token);
    await store.SaveAsync(state);

    return Results.Ok(AuthResponse.From(user, token.Token));
});

api.MapGet("/auth/google/start", (HttpContext context, IConfiguration configuration) =>
{
    var clientId = configuration["Authentication:Google:ClientId"];
    var clientSecret = configuration["Authentication:Google:ClientSecret"];
    if (string.IsNullOrWhiteSpace(clientId) || string.IsNullOrWhiteSpace(clientSecret))
    {
        return Results.BadRequest(new ApiError("Google redirect sign-in is not configured."));
    }

    var state = Convert.ToBase64String(RandomNumberGenerator.GetBytes(24));
    context.Response.Cookies.Append("google_oauth_state", state, new CookieOptions
    {
        HttpOnly = true,
        IsEssential = true,
        SameSite = SameSiteMode.Lax,
        Secure = false,
        MaxAge = TimeSpan.FromMinutes(10)
    });

    var redirectUri = $"{context.Request.Scheme}://{context.Request.Host}/api/auth/google/callback";
    var url = "https://accounts.google.com/o/oauth2/v2/auth" +
        $"?client_id={Uri.EscapeDataString(clientId)}" +
        $"&redirect_uri={Uri.EscapeDataString(redirectUri)}" +
        "&response_type=code" +
        $"&scope={Uri.EscapeDataString("openid email profile")}" +
        $"&state={Uri.EscapeDataString(state)}" +
        "&prompt=select_account";

    return Results.Redirect(url);
});

api.MapGet("/auth/google/callback", async (
    string? code,
    string? state,
    HttpContext context,
    GoogleTokenValidator validator,
    AppStore store) =>
{
    var expectedState = context.Request.Cookies["google_oauth_state"];
    context.Response.Cookies.Delete("google_oauth_state");

    if (string.IsNullOrWhiteSpace(code) || string.IsNullOrWhiteSpace(state) || expectedState != state)
    {
        return Results.Redirect("http://localhost:4200/#googleError=state");
    }

    var redirectUri = $"{context.Request.Scheme}://{context.Request.Host}/api/auth/google/callback";
    var idToken = await validator.ExchangeAuthorizationCodeAsync(code, redirectUri);
    var payload = idToken is null ? null : await validator.ValidateAsync(idToken);
    if (payload is null)
    {
        return Results.Redirect("http://localhost:4200/#googleError=token");
    }

    var normalizedEmail = payload.Email.Trim().ToLowerInvariant();
    var appState = await store.LoadAsync();
    var user = appState.Users.FirstOrDefault(candidate => candidate.GoogleSubject == payload.Subject)
        ?? appState.Users.FirstOrDefault(candidate => candidate.Email == normalizedEmail);

    if (user is null)
    {
        user = UserRecord.CreateGoogle(payload.Name, normalizedEmail, payload.Subject);
        appState.Users.Add(user);
    }
    else
    {
        user.GoogleSubject = payload.Subject;
        user.Name = string.IsNullOrWhiteSpace(user.Name) ? payload.Name : user.Name;
    }

    var token = SessionRecord.Create(user.Id);
    appState.Sessions.Add(token);
    await store.SaveAsync(appState);

    return Results.Redirect($"http://localhost:4200/#token={Uri.EscapeDataString(token.Token)}");
});

api.MapGet("/me", async (HttpContext context, AppStore store) =>
{
    var auth = await RequireUserAsync(context, store);
    return auth.User is null ? Results.Unauthorized() : Results.Ok(UserDto.From(auth.User));
});

api.MapGet("/preferences", async (HttpContext context, AppStore store) =>
{
    var auth = await RequireUserAsync(context, store);
    if (auth.User is null)
    {
        return Results.Unauthorized();
    }

    return Results.Ok(auth.User.Preferences);
});

api.MapPut("/preferences", async (ScopePreference preferences, HttpContext context, AppStore store) =>
{
    var auth = await RequireUserAsync(context, store);
    if (auth.User is null)
    {
        return Results.Unauthorized();
    }

    auth.User.Preferences = preferences.Normalized();
    await store.SaveAsync(auth.State);

    return Results.Ok(auth.User.Preferences);
});

api.MapGet("/readings", async (HttpContext context, AppStore store) =>
{
    var auth = await RequireUserAsync(context, store);
    if (auth.User is null)
    {
        return Results.Unauthorized();
    }

    return Results.Ok(auth.User.Readings.OrderByDescending(reading => reading.CreatedAt));
});

api.MapPost("/readings", async (SaveReadingRequest request, HttpContext context, AppStore store) =>
{
    var auth = await RequireUserAsync(context, store);
    if (auth.User is null)
    {
        return Results.Unauthorized();
    }

    if (request.StartIndex < 0 || request.EndIndex < request.StartIndex || request.EndIndex > 6235)
    {
        return Results.BadRequest(new ApiError("Invalid reading range."));
    }

    var reading = new ReadingHistoryRecord(
        Guid.NewGuid().ToString("N"),
        string.IsNullOrWhiteSpace(request.Name) ? "جلسة قراءة" : request.Name.Trim(),
        request.StartIndex,
        request.EndIndex,
        DateTimeOffset.UtcNow);

    auth.User.Readings.Add(reading);
    await store.SaveAsync(auth.State);

    return Results.Ok(reading);
});

api.MapDelete("/readings/{id}", async (string id, HttpContext context, AppStore store) =>
{
    var auth = await RequireUserAsync(context, store);
    if (auth.User is null)
    {
        return Results.Unauthorized();
    }

    auth.User.Readings.RemoveAll(reading => reading.Id == id);
    await store.SaveAsync(auth.State);

    return Results.NoContent();
});

app.Run();

static async Task<AuthContext> RequireUserAsync(HttpContext context, AppStore store)
{
    var state = await store.LoadAsync();
    var header = context.Request.Headers.Authorization.ToString();
    var token = header.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase)
        ? header["Bearer ".Length..].Trim()
        : string.Empty;

    if (string.IsNullOrWhiteSpace(token))
    {
        return new AuthContext(state, null);
    }

    var session = state.Sessions.FirstOrDefault(candidate => candidate.Token == token);
    var user = session is null ? null : state.Users.FirstOrDefault(candidate => candidate.Id == session.UserId);

    return new AuthContext(state, user);
}

record AuthRequest(string Email, string Password, string? Name);

record GoogleAuthRequest(string Credential);

record PublicConfig(string GoogleClientId, bool GoogleRedirectEnabled);

record GooglePayload(string Subject, string Email, string Name);

record ApiError(string Message);

record AuthResponse(string Token, UserDto User)
{
    public static AuthResponse From(UserRecord user, string token) => new(token, UserDto.From(user));
}

record UserDto(string Id, string Name, string Email)
{
    public static UserDto From(UserRecord user) => new(user.Id, user.Name, user.Email);
}

record SaveReadingRequest(string Name, int StartIndex, int EndIndex);

record ReadingHistoryRecord(string Id, string Name, int StartIndex, int EndIndex, DateTimeOffset CreatedAt);

record SessionRecord(string Token, string UserId, DateTimeOffset CreatedAt)
{
    public static SessionRecord Create(string userId)
    {
        var bytes = RandomNumberGenerator.GetBytes(32);
        return new SessionRecord(Convert.ToBase64String(bytes), userId, DateTimeOffset.UtcNow);
    }
}

record ScopePreference(string Mode, int FromJuz, int ToJuz, int FromSurah, int ToSurah, int Ayah)
{
    public static ScopePreference Default => new("all", 1, 30, 1, 114, 1);

    public ScopePreference Normalized()
    {
        var mode = string.IsNullOrWhiteSpace(Mode) ? "all" : Mode.Trim().ToLowerInvariant();
        return this with
        {
            Mode = mode,
            FromJuz = Math.Clamp(FromJuz, 1, 30),
            ToJuz = Math.Clamp(ToJuz, 1, 30),
            FromSurah = Math.Clamp(FromSurah, 1, 114),
            ToSurah = Math.Clamp(ToSurah, 1, 114),
            Ayah = Math.Max(1, Ayah)
        };
    }
}

class UserRecord
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string Name { get; set; } = "";
    public string Email { get; set; } = "";
    public string PasswordHash { get; set; } = "";
    public string PasswordSalt { get; set; } = "";
    public string? GoogleSubject { get; set; }
    public ScopePreference Preferences { get; set; } = ScopePreference.Default;
    public List<ReadingHistoryRecord> Readings { get; set; } = [];

    public static UserRecord Create(string? name, string email, string password)
    {
        var salt = RandomNumberGenerator.GetBytes(16);
        var hash = HashPassword(password, salt);

        return new UserRecord
        {
            Name = string.IsNullOrWhiteSpace(name) ? email.Split('@')[0] : name,
            Email = email,
            PasswordSalt = Convert.ToBase64String(salt),
            PasswordHash = Convert.ToBase64String(hash)
        };
    }

    public bool VerifyPassword(string password)
    {
        if (string.IsNullOrWhiteSpace(PasswordHash) || string.IsNullOrWhiteSpace(PasswordSalt))
        {
            return false;
        }

        var salt = Convert.FromBase64String(PasswordSalt);
        var expectedHash = Convert.FromBase64String(PasswordHash);
        var actualHash = HashPassword(password, salt);
        return CryptographicOperations.FixedTimeEquals(expectedHash, actualHash);
    }

    public static UserRecord CreateGoogle(string name, string email, string googleSubject)
    {
        return new UserRecord
        {
            Name = string.IsNullOrWhiteSpace(name) ? email.Split('@')[0] : name,
            Email = email,
            GoogleSubject = googleSubject
        };
    }

    private static byte[] HashPassword(string password, byte[] salt) =>
        Rfc2898DeriveBytes.Pbkdf2(password, salt, 100_000, HashAlgorithmName.SHA256, 32);
}

class GoogleTokenValidator(HttpClient httpClient, IConfiguration configuration)
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

    record JsonWebKeySet(List<JsonWebKey> Keys);

    record JsonWebKey(string Kid, string Kty, string N, string E);

    record GoogleTokenResponse([property: JsonPropertyName("id_token")] string IdToken);
}

class AppState
{
    public List<UserRecord> Users { get; set; } = [];
    public List<SessionRecord> Sessions { get; set; } = [];
}

record AuthContext(AppState State, UserRecord? User);

class AppStore(IWebHostEnvironment environment)
{
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly JsonSerializerOptions _jsonOptions = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true,
        Converters = { new JsonStringEnumConverter() }
    };
    private readonly string _path = Path.Combine(environment.ContentRootPath, "App_Data", "app-data.json");

    public async Task<AppState> LoadAsync()
    {
        await _gate.WaitAsync();
        try
        {
            if (!File.Exists(_path))
            {
                return new AppState();
            }

            await using var stream = File.OpenRead(_path);
            return await JsonSerializer.DeserializeAsync<AppState>(stream, _jsonOptions) ?? new AppState();
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task SaveAsync(AppState state)
    {
        await _gate.WaitAsync();
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
            await using var stream = File.Create(_path);
            await JsonSerializer.SerializeAsync(stream, state, _jsonOptions);
        }
        finally
        {
            _gate.Release();
        }
    }
}
