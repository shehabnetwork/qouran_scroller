public class ScopePreference
{
    public string Mode { get; set; } = "all";
    public int FromJuz { get; set; } = 1;
    public int ToJuz { get; set; } = 30;
    public int FromSurah { get; set; } = 1;
    public int ToSurah { get; set; } = 114;
    public int Ayah { get; set; } = 1;

    public static ScopePreference Default => new();

    public ScopePreference Normalized()
    {
        var mode = string.IsNullOrWhiteSpace(Mode) ? "all" : Mode.Trim().ToLowerInvariant();

        return new ScopePreference
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
