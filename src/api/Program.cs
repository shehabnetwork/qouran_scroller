using Microsoft.EntityFrameworkCore;
using System.Security.Cryptography;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddCors(options =>
{
    options.AddDefaultPolicy(policy =>
        policy.WithOrigins("http://localhost:4200")
            .AllowAnyHeader()
            .AllowAnyMethod());
});
builder.Services.AddDbContext<AppDbContext>((services, options) =>
{
    var environment = services.GetRequiredService<IWebHostEnvironment>();
    var dataDirectory = Path.Combine(environment.ContentRootPath, "App_Data");
    Directory.CreateDirectory(dataDirectory);

    options.UseSqlite($"Data Source={Path.Combine(dataDirectory, "app.db")}");
});
builder.Services.AddHttpClient<GoogleTokenValidator>();
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen();

var app = builder.Build();

await AppDbInitializer.InitializeAsync(app);

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

api.MapPost("/auth/register", async (AuthRequest request, AppDbContext db) =>
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
    if (await db.Users.AnyAsync(user => user.Email == normalizedEmail))
    {
        return Results.Conflict(new ApiError("This email is already registered."));
    }

    var user = UserRecord.Create(request.Name?.Trim(), normalizedEmail, request.Password);
    var token = SessionRecord.Create(user.Id);

    db.Users.Add(user);
    db.Sessions.Add(token);
    await db.SaveChangesAsync();

    return Results.Ok(AuthResponse.From(user, token.Token));
});

api.MapPost("/auth/login", async (AuthRequest request, AppDbContext db) =>
{
    if (string.IsNullOrWhiteSpace(request.Email) || string.IsNullOrWhiteSpace(request.Password))
    {
        return Results.Unauthorized();
    }

    var normalizedEmail = request.Email.Trim().ToLowerInvariant();
    var user = await db.Users.FirstOrDefaultAsync(candidate => candidate.Email == normalizedEmail);

    if (user is null || !user.VerifyPassword(request.Password))
    {
        return Results.Unauthorized();
    }

    var token = SessionRecord.Create(user.Id);
    db.Sessions.Add(token);
    await db.SaveChangesAsync();

    return Results.Ok(AuthResponse.From(user, token.Token));
});

api.MapPost("/auth/google", async (GoogleAuthRequest request, GoogleTokenValidator validator, AppDbContext db) =>
{
    var payload = await validator.ValidateAsync(request.Credential);
    if (payload is null)
    {
        return Results.BadRequest(new ApiError("Google sign-in is not configured or the token is invalid."));
    }

    var normalizedEmail = payload.Email.Trim().ToLowerInvariant();
    var user = await db.Users.FirstOrDefaultAsync(candidate => candidate.GoogleSubject == payload.Subject)
        ?? await db.Users.FirstOrDefaultAsync(candidate => candidate.Email == normalizedEmail);

    if (user is null)
    {
        user = UserRecord.CreateGoogle(payload.Name, normalizedEmail, payload.Subject);
        db.Users.Add(user);
    }
    else
    {
        user.GoogleSubject = payload.Subject;
        user.Name = string.IsNullOrWhiteSpace(user.Name) ? payload.Name : user.Name;
    }

    var token = SessionRecord.Create(user.Id);
    db.Sessions.Add(token);
    await db.SaveChangesAsync();

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
    AppDbContext db) =>
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
    var user = await db.Users.FirstOrDefaultAsync(candidate => candidate.GoogleSubject == payload.Subject)
        ?? await db.Users.FirstOrDefaultAsync(candidate => candidate.Email == normalizedEmail);

    if (user is null)
    {
        user = UserRecord.CreateGoogle(payload.Name, normalizedEmail, payload.Subject);
        db.Users.Add(user);
    }
    else
    {
        user.GoogleSubject = payload.Subject;
        user.Name = string.IsNullOrWhiteSpace(user.Name) ? payload.Name : user.Name;
    }

    var token = SessionRecord.Create(user.Id);
    db.Sessions.Add(token);
    await db.SaveChangesAsync();

    return Results.Redirect($"http://localhost:4200/#token={Uri.EscapeDataString(token.Token)}");
});

api.MapGet("/me", async (HttpContext context, AppDbContext db) =>
{
    var auth = await RequireUserAsync(context, db);
    return auth.User is null ? Results.Unauthorized() : Results.Ok(UserDto.From(auth.User));
});

api.MapGet("/preferences", async (HttpContext context, AppDbContext db) =>
{
    var auth = await RequireUserAsync(context, db);
    if (auth.User is null)
    {
        return Results.Unauthorized();
    }

    return Results.Ok(auth.User.Preferences);
});

api.MapPut("/preferences", async (ScopePreference preferences, HttpContext context, AppDbContext db) =>
{
    var auth = await RequireUserAsync(context, db);
    if (auth.User is null)
    {
        return Results.Unauthorized();
    }

    auth.User.Preferences = preferences.Normalized();
    await db.SaveChangesAsync();

    return Results.Ok(auth.User.Preferences);
});

api.MapGet("/readings", async (HttpContext context, AppDbContext db) =>
{
    var auth = await RequireUserAsync(context, db);
    if (auth.User is null)
    {
        return Results.Unauthorized();
    }

    return Results.Ok(auth.User.Readings.OrderByDescending(reading => reading.CreatedAt));
});

api.MapPost("/readings", async (SaveReadingRequest request, HttpContext context, AppDbContext db) =>
{
    var auth = await RequireUserAsync(context, db);
    if (auth.User is null)
    {
        return Results.Unauthorized();
    }

    if (request.StartIndex < 0 || request.EndIndex < request.StartIndex || request.EndIndex > 6235)
    {
        return Results.BadRequest(new ApiError("Invalid reading range."));
    }

    var reading = ReadingHistoryRecord.Create(
        auth.User.Id,
        string.IsNullOrWhiteSpace(request.Name) ? "جلسة جديدة" : request.Name.Trim(),
        request.StartIndex,
        request.EndIndex);

    db.Readings.Add(reading);
    await db.SaveChangesAsync();

    return Results.Ok(reading);
});

api.MapDelete("/readings/{id}", async (string id, HttpContext context, AppDbContext db) =>
{
    var auth = await RequireUserAsync(context, db);
    if (auth.User is null)
    {
        return Results.Unauthorized();
    }

    var reading = auth.User.Readings.FirstOrDefault(candidate => candidate.Id == id);
    if (reading is not null)
    {
        db.Readings.Remove(reading);
        await db.SaveChangesAsync();
    }

    return Results.NoContent();
});

app.Run();

static async Task<AuthContext> RequireUserAsync(HttpContext context, AppDbContext db)
{
    var header = context.Request.Headers.Authorization.ToString();
    var token = header.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase)
        ? header["Bearer ".Length..].Trim()
        : string.Empty;

    if (string.IsNullOrWhiteSpace(token))
    {
        return new AuthContext(null);
    }

    var session = await db.Sessions.AsNoTracking().FirstOrDefaultAsync(candidate => candidate.Token == token);
    if (session is null)
    {
        return new AuthContext(null);
    }

    var user = await db.Users
        .Include(candidate => candidate.Readings)
        .FirstOrDefaultAsync(candidate => candidate.Id == session.UserId);

    return new AuthContext(user);
}
