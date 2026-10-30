# Install on an iPhone

**Use a free Apple ID now: it works, but the app stops opening after 7 days until you reinstall it.** Move to TestFlight
when you buy the developer program.

These steps have not been run yet, because they need the Mac and the iPhone. Fix anything that turns out wrong.

## Free Apple ID (now)
You need the Mac with Xcode, Rust and the iPhone on a cable.

1. **Add your Apple ID:** Xcode > Settings > Accounts.
2. **Build the Rust link:**
   ```sh
   cd mobile
   npm ci
   node scripts/build-native-link.mjs ios --device-only
   ```
3. **Generate the iOS project:** `npx expo prebuild --platform ios`
4. **Choose your team:** open `ios/*.xcworkspace`, select the app target, then Signing & Capabilities, and pick your
   personal team. The bundle ID is `com.clupai.monocode`.
5. **Install it:** `npx expo run:ios --device --configuration Release`
6. **Trust it on the iPhone:**
   - Turn on Settings > Privacy & Security > Developer Mode, then restart.
   - Trust your Apple ID under Settings > General > VPN & Device Management.
7. **Set up the phone:**
   - Install Tailscale and sign in, so the phone can reach your machines.
   - Install ntfy for alerts while the app is closed, then follow Settings > Push notifications in the app.
8. **Pair it:** scan the code from the desktop's Settings > Connections.

**Every 7 days:** plug in and repeat step 5. Your pairing and settings should stay.

### Limits of a free Apple ID
- The signature lasts 7 days, and only 3 free apps can be installed at once.
- There is no Apple push. The app already asks for none, so signing works, and ntfy covers alerts.
- Live Activities can update only from the app itself, not from a push.

## TestFlight (after buying the program, $99 a year)
1. Create an Expo project and link it: `npx eas-cli@latest init`. This fills in the `owner` and `projectId` that were
   removed from `app.json`.
2. Set `updates.url` and `updates.enabled: true` in `app.json` if you want over-the-air updates.
3. Build and send it: `npm run build:ios`, then `npm run submit:ios`.

## Android
The package stays `com.hardbeat920.monocodemobile`, so the Nothing Phone's app updates in place.
