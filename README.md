# Quran Scroll

Arabic Quran reader that opens on a random verse, then lets the reader continue downward through the following verses.

## Stack

- Angular frontend in `src/web`
- ASP.NET Core backend in `src/api`
- Quran text: Tanzil Uthmani Quran text, version 1.1, with tashkeel

## Run Locally

Start the API:

```bash
dotnet run --project src/api/QuranScroll.Api.csproj --urls http://localhost:5037
```

Start Angular:

```bash
cd src/web
npm start -- --port 4200
```

Open `http://localhost:4200`.

## Google Login

Create a Google OAuth 2.0 Web client ID in Google Cloud Console, then add `http://localhost:4200` as an authorized JavaScript origin.

For local development, set the client ID with an environment variable before starting the API:

```bash
export Authentication__Google__ClientId="YOUR_CLIENT_ID.apps.googleusercontent.com"
export Authentication__Google__ClientSecret="YOUR_CLIENT_SECRET"
dotnet run --project src/api/QuranScroll.Api.csproj --urls http://localhost:5037
```

For the redirect fallback, also add this authorized redirect URI:

```text
http://localhost:5037/api/auth/google/callback
```

You can also place the client ID and secret in `src/api/appsettings.Development.json` under `Authentication:Google`. The frontend reads public config from `/api/config`; the backend verifies Google ID tokens before creating the local app session.

## Quran Source

The Quran data is generated from Tanzil's Uthmani Quran text:

- Download page: https://tanzil.net/download/
- Metadata: https://tanzil.net/docs/quran_metadata

Tanzil requires that the source is clearly indicated and linked, and that the Quran text is not modified. The app keeps an attribution link in the UI.

To regenerate the embedded data after downloading fresh Tanzil files to `/tmp/quran-uthmani.txt` and `/tmp/quran-data.xml`:

```bash
node tools/generate-quran-data.mjs
```
