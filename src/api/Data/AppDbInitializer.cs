using Microsoft.EntityFrameworkCore;
using System.Text.Json;

public static class AppDbInitializer
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public static async Task InitializeAsync(WebApplication app)
    {
        using var scope = app.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

        await db.Database.EnsureCreatedAsync();
        await ImportLegacyJsonAsync(db, app.Environment);
    }

    private static async Task ImportLegacyJsonAsync(AppDbContext db, IWebHostEnvironment environment)
    {
        if (await db.Users.AnyAsync())
        {
            return;
        }

        var legacyPath = Path.Combine(environment.ContentRootPath, "App_Data", "app-data.json");
        if (!File.Exists(legacyPath))
        {
            return;
        }

        await using var stream = File.OpenRead(legacyPath);
        var state = await JsonSerializer.DeserializeAsync<LegacyAppState>(stream, JsonOptions);
        if (state is null || state.Users.Count == 0)
        {
            return;
        }

        foreach (var user in state.Users)
        {
            user.Preferences = user.Preferences.Normalized();

            foreach (var reading in user.Readings)
            {
                reading.UserId = user.Id;
            }
        }

        var userIds = state.Users.Select(user => user.Id).ToHashSet(StringComparer.Ordinal);
        var sessions = state.Sessions.Where(session => userIds.Contains(session.UserId)).ToList();

        db.Users.AddRange(state.Users);
        db.Sessions.AddRange(sessions);
        await db.SaveChangesAsync();
    }

    private sealed class LegacyAppState
    {
        public List<UserRecord> Users { get; set; } = [];
        public List<SessionRecord> Sessions { get; set; } = [];
    }
}
