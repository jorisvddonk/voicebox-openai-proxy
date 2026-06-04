# Voicebox OpenAI Proxy

Exposes a subset of the [OpenAI Audio API](https://platform.openai.com/docs/api-reference/audio) using [Voicebox](https://voicebox.sh/) as the backend.

Compatible with any OpenAI SDK or client that supports a custom `base_url`.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/models` | List available voices (from Voicebox profiles) |
| `POST` | `/v1/audio/speech` | Text-to-speech generation |
| `POST` | `/v1/audio/transcriptions` | Speech-to-text transcription |
| `POST` | `/` | Alias for `/v1/audio/speech` |
| `GET` | `/health` | Health check |

## Usage

```sh
# Set your Voicebox backend
export VOICEBOX_BASE_URL=http://127.0.0.1:17493

# Start the proxy
node openai-adapter.js
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `VOICEBOX_BASE_URL` | `http://127.0.0.1:17493` | Voicebox backend address |
| `PORT` | `17494` | Proxy listen port |
| `API_KEYS` | — | Comma-separated list of allowed API keys (unset = disabled) |

## Audio Format Conversion

Requires `ffmpeg` on `PATH` for `mp3`, `opus`, `flac`, or `pcm` output. Falls back to WAV if ffmpeg is unavailable.

## License

MIT
