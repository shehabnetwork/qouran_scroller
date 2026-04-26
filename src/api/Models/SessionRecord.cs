using System.Security.Cryptography;
using System.Text.Json.Serialization;

public class SessionRecord
{
    public string Token { get; set; } = "";
    public string UserId { get; set; } = "";
    public DateTimeOffset CreatedAt { get; set; }

    [JsonIgnore]
    public UserRecord? User { get; set; }

    public static SessionRecord Create(string userId)
    {
        var bytes = RandomNumberGenerator.GetBytes(32);
        return new SessionRecord
        {
            Token = Convert.ToBase64String(bytes),
            UserId = userId,
            CreatedAt = DateTimeOffset.UtcNow
        };
    }
}
