# Project Review Report

## 1. Project Manager
* Phase 0-3 tasks complete (crash fixes, correctness, missing modules).
* Greek micro parsing, sinusoidal 2/π switching loss, bypass cap dissipation, and tiered MOSFET safety warnings ALREADY merged to `main`.
* Pending: `qoss` display (§4a) and MCU validation sub-module (§4d).
* Deferred: Multi-motor compatibility feature (Phase 4).

## 2. Senior Software Dev
* `main.py` FastAPI structure robust. 
* `claude_service.py` correctly handles 503 exponential backoff, 429 quota exhaustion, and SHA-256 disk cache.
* Frontend `api.js` timeout (11m for extraction, 30s other) implemented properly.
* Error message sanitization active — no raw exceptions leaked.

## 3. Hardware Engineer
* **Unit Parsing:** `unit_utils.py` handles Greek µ (U+03BC) to U+00B5 safely.
* **Switching Loss:** `mosfet.py` implements sinusoidal 2/π averaging (`sin_avg = 2.0 / math.pi`) and Qgd-based Miller transition times.
* **Passives:** `passives.py` correctly handles DC link ripple via Kolar analytical integration. Bypass capacitor dissipation explicitly set to 0.0W (heat is in driver).
* **Thermal:** Iterative `Tj` solver with user-overridable `rds_alpha` prevents runaway.
* **MOSFET Derating:** Tiered warnings (Danger <1.0x, Warn <1.25x, Caution <1.5x) active for `Id_cont` and Avalanche `Ias`.

## 4. Frontend UI/UX
* **React Codebase:** `ProjectContext.jsx` handles global state well.
* **Light Theme:** `index.css` has explicit `.light` overrides for contrast (e.g. `txt-3` 4.8:1 ratio).
* **Missing Components:** `CalculationsPanel.jsx` is missing `coss_loss_per_fet_w` and `qoss_loss_per_fet_w` in the display grid. This needs fixing.
