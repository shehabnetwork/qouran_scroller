using Microsoft.EntityFrameworkCore;

public class AppDbContext(DbContextOptions<AppDbContext> options) : DbContext(options)
{
    public DbSet<UserRecord> Users => Set<UserRecord>();
    public DbSet<SessionRecord> Sessions => Set<SessionRecord>();
    public DbSet<ReadingHistoryRecord> Readings => Set<ReadingHistoryRecord>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<UserRecord>(entity =>
        {
            entity.ToTable("users");
            entity.HasKey(user => user.Id);
            entity.HasIndex(user => user.Email).IsUnique();
            entity.HasIndex(user => user.GoogleSubject).IsUnique();

            entity.Property(user => user.Id).HasMaxLength(32);
            entity.Property(user => user.Name).HasMaxLength(200).IsRequired();
            entity.Property(user => user.Email).HasMaxLength(320).IsRequired();
            entity.Property(user => user.PasswordHash).IsRequired();
            entity.Property(user => user.PasswordSalt).IsRequired();
            entity.Property(user => user.GoogleSubject).HasMaxLength(200);

            entity.OwnsOne(user => user.Preferences, preferences =>
            {
                preferences.Property(preference => preference.Mode).HasColumnName("PreferenceMode").HasMaxLength(20).IsRequired();
                preferences.Property(preference => preference.FromJuz).HasColumnName("PreferenceFromJuz");
                preferences.Property(preference => preference.ToJuz).HasColumnName("PreferenceToJuz");
                preferences.Property(preference => preference.FromSurah).HasColumnName("PreferenceFromSurah");
                preferences.Property(preference => preference.ToSurah).HasColumnName("PreferenceToSurah");
                preferences.Property(preference => preference.Ayah).HasColumnName("PreferenceAyah");
            });

            entity.Navigation(user => user.Preferences).IsRequired();
            entity.HasMany(user => user.Readings)
                .WithOne(reading => reading.User)
                .HasForeignKey(reading => reading.UserId)
                .OnDelete(DeleteBehavior.Cascade);
            entity.HasMany(user => user.Sessions)
                .WithOne(session => session.User)
                .HasForeignKey(session => session.UserId)
                .OnDelete(DeleteBehavior.Cascade);
        });

        modelBuilder.Entity<SessionRecord>(entity =>
        {
            entity.ToTable("sessions");
            entity.HasKey(session => session.Token);

            entity.Property(session => session.Token).HasMaxLength(128);
            entity.Property(session => session.UserId).HasMaxLength(32).IsRequired();
            entity.Property(session => session.CreatedAt).IsRequired();
        });

        modelBuilder.Entity<ReadingHistoryRecord>(entity =>
        {
            entity.ToTable("reading_history");
            entity.HasKey(reading => reading.Id);
            entity.HasIndex(reading => reading.UserId);

            entity.Property(reading => reading.Id).HasMaxLength(32);
            entity.Property(reading => reading.UserId).HasMaxLength(32).IsRequired();
            entity.Property(reading => reading.Name).HasMaxLength(200).IsRequired();
            entity.Property(reading => reading.CreatedAt).IsRequired();
        });
    }
}
