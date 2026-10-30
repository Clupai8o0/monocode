# Phone parity audit (31 Oct 2026)

**Result: no known Android crash is left in the code, but nothing here has run on an iPhone or a simulator yet.**
This comes from reading the code. `tests/nativeParity.test.ts` keeps SwiftUI off Android from now on.

| Screen | iOS | Android | Status |
|---|---|---|---|
| Pairing | Plain views | Same | Unchecked on iOS |
| Projects, sessions | SwiftUI filter menu | List sheet | Android guarded |
| Chat, composer | SwiftUI attach menu | List sheet | Android guarded |
| Model picker | SwiftUI slider | List sheet | Android guarded |
| Approvals (`ApprovalBar`) | Plain views | Same | Unchecked on iOS |
| Turn metrics | SwiftUI sheet | `.android` file | Android guarded |
| Files | SwiftUI list | `.android` file | Android guarded |
| Changes | Plain views | Same | Unchecked on iOS |
| Commit sheet | Universal sheet, SwiftUI sizing | Universal sheet | Android guarded |
| Workspace menu | SwiftUI menu | `.android` file | Android guarded |
| Terminal | Plain views | Same | Unchecked on iOS |
| Monos | Plain views | Same | Unchecked on iOS |
| Home lab | Plain views | Same | Font fixed, unchecked on iOS |
| Elsewhere | Plain views | Same | Unchecked on iOS |
| Push | Plain views | Same | Unchecked on iOS |
| Appearance | SwiftUI picker, slider | List sheet | Android guarded |

## What changed
- **The three Android crashes in the plan were already fixed** (Appearance, Commit sheet, Files). This phase adds the test.
- **iOS fix:** Home lab asked for a font called `monospace`, which iOS doesn't have. It now uses Menlo.

## Check first on iOS
Run these screens first, because they have never run on iOS: Terminal (keyboard), Home lab, Elsewhere, Push and the
approval bar.
