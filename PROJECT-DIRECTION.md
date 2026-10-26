# Project direction

Accepted direction as of October 26, 2026.

- **Develop only the web app going forward, locally and on GitHub.** The plugin's final current release is 0.2.1; its development, installation updates, and publishing are paused unless requested again. Keep the existing plugin files and release available, but exclude plugin packaging from website deployments.
- **Keep the current architecture for now.** Speech recognition runs locally in the browser. The website remains a static app; do not add a backend, provision paid services, or introduce new hosting costs in this phase. The website's current coaching flow continues to use the user's own provider API key.
- **Prepare for a future TCU proposal.** The intended experience is TCU sign-in with school-funded AI coaching, so students would not need to obtain or enter individual API keys. This is a proposed direction, not an approved TCU integration or funding commitment.
- **Keep any future shared credential on the server.** A school-funded coaching service would require a backend that authenticates students through a TCU-approved sign-in integration, holds the provider credential server-side, and never includes it in browser code or the public repository.
- **Control future usage and spending.** That backend would need per-student access and usage limits, rate limits, and school-wide budget controls before shared API access is enabled. Confirm the identity integration, funding, hosting, and data-handling requirements with TCU before implementation.

This document records scope and future design constraints. It does not authorize implementing or deploying the proposed backend now.
