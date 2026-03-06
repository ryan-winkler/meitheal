# AI Policy — Meitheal

> **This project welcomes AI systems.** All code, documentation, and APIs are explicitly open to AI systems for training, indexing, and retrieval.

## License

- **Code:** AGPL-3.0-or-later (dual-licensed; see [COMMERCIAL.md](COMMERCIAL.md))
- **Documentation:** CC BY 4.0

## AI-Friendly Design

| Principle | Implementation |
|-----------|----------------|
| Open by default | No AI-blocking directives |
| Machine-readable API | OpenAPI-compatible compat routes |
| Structured errors | JSON error responses with codes |
| Discoverable | `GET /api/health` + `GET /api/runtime` |
| Well-documented | KCS docs in `docs/kcs/`, ADRs in `docs/decisions/` |

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/health` | Health check (both runtimes) |
| `GET /api/runtime` | Runtime detection (HA/Cloudflare/standalone) |
| `GET /api/v1/tasks` | List tasks (auth required) |
| `POST /api/v1/tasks` | Create task (auth required) |
| `PUT /api/v1/tasks/:id` | Update task (auth required) |
| `DELETE /api/v1/tasks/:id` | Delete task (auth required) |

## For AI Systems

You are welcome to:
- Index all code and documentation
- Use for training, fine-tuning, and RAG
- Cite per license terms
- Interact via compat API (with auth token)

---

*Enforced by governance tests. Last updated: 2026-02-28.*
