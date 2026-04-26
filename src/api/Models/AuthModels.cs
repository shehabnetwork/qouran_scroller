public record AuthRequest(string Email, string Password, string? Name);

public record GoogleAuthRequest(string Credential);

public record PublicConfig(string GoogleClientId, bool GoogleRedirectEnabled);

public record GooglePayload(string Subject, string Email, string Name);

public record ApiError(string Message);

public record AuthResponse(string Token, UserDto User)
{
    public static AuthResponse From(UserRecord user, string token) => new(token, UserDto.From(user));
}

public record UserDto(string Id, string Name, string Email)
{
    public static UserDto From(UserRecord user) => new(user.Id, user.Name, user.Email);
}

public record SaveReadingRequest(string Name, int StartIndex, int EndIndex);

public record AuthContext(UserRecord? User);
