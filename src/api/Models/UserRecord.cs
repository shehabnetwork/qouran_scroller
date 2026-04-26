using System.Security.Cryptography;

public class UserRecord
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string Name { get; set; } = "";
    public string Email { get; set; } = "";
    public string PasswordHash { get; set; } = "";
    public string PasswordSalt { get; set; } = "";
    public string? GoogleSubject { get; set; }
    public ScopePreference Preferences { get; set; } = ScopePreference.Default;
    public List<ReadingHistoryRecord> Readings { get; set; } = [];
    public List<SessionRecord> Sessions { get; set; } = [];

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

    public static UserRecord CreateGoogle(string name, string email, string googleSubject) =>
        new()
        {
            Name = string.IsNullOrWhiteSpace(name) ? email.Split('@')[0] : name,
            Email = email,
            GoogleSubject = googleSubject
        };

    private static byte[] HashPassword(string password, byte[] salt) =>
        Rfc2898DeriveBytes.Pbkdf2(password, salt, 100_000, HashAlgorithmName.SHA256, 32);
}
