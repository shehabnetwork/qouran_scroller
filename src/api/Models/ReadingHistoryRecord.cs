using System.Text.Json.Serialization;

public class ReadingHistoryRecord
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string UserId { get; set; } = "";
    public string Name { get; set; } = "";
    public int StartIndex { get; set; }
    public int EndIndex { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;

    [JsonIgnore]
    public UserRecord? User { get; set; }

    public static ReadingHistoryRecord Create(string userId, string name, int startIndex, int endIndex) =>
        new()
        {
            Id = Guid.NewGuid().ToString("N"),
            UserId = userId,
            Name = name,
            StartIndex = startIndex,
            EndIndex = endIndex,
            CreatedAt = DateTimeOffset.UtcNow
        };
}
