# Keys and accounts

No secret ever goes into this repository. Put keys into `.env.local` (git-ignored); they are then copied to the
service that needs them (Vercel env or the relay's secret store).

| Stage | Service | How to get it | Variable |
| --- | --- | --- | --- |
| 2 | OpenSky Network | Create an account at opensky-network.org, open *My OpenSky → Account*, create an **API client** | `OPENSKY_CLIENT_ID`, `OPENSKY_CLIENT_SECRET` |
| 2 | aisstream.io | *Sign in with GitHub*, open *API Keys*, create a key (it is shown once) | `AISSTREAM_API_KEY` |
| 2 | Cloudflare | Free account (no card) for the relay worker; then `npx wrangler login` on the dev PC | — |
| 3 | Google AI Studio | Gemini API key on the free tier | `GEMINI_API_KEY` |

Not needed: NASA FIRMS (public 24 h CSV files), USGS, CelesTrak, NASA GIBS, Digitraffic.
