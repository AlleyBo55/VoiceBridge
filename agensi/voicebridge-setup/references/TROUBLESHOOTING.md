# Troubleshooting VoiceBridge

Start every investigation the same way:

1. Run the doctor (`scripts/doctor.sh` or `scripts/doctor.ps1`) and fix any MISSING line first, with the user's approval.
2. Read VoiceBridge's own log output. A source build prints main-process messages in the terminal running `npm run dev`, and DevTools shows interface errors. To see the same messages from an installed app, start it from a terminal (macOS: `/Applications/VoiceBridge.app/Contents/MacOS/VoiceBridge`).
3. Find out which half is failing. If the VoiceBridge window shows the transcript and the translation, capture and translation work, and the problem is audio routing. If no transcript appears, the problem is the microphone, ffmpeg or the API keys.

Never ask the user for API keys or voice recordings while troubleshooting. Keys are fixed in the app's Settings by the user.

## No audio in the meeting

Work down this list; most cases stop at one of the first four items.

1. **Translation is off or not triggered.** The toggle at the top right of the main window must be on. With Push-to-talk mode enabled, the user must hold Space in the VoiceBridge window while speaking.
2. **The meeting app uses the wrong microphone.** It must be the virtual device: `BlackHole 2ch` (macOS), `Monitor of VoiceBridge Mic` (Linux), `CABLE Output (VB-Audio Virtual Cable)` (Windows). See the next section.
3. **The meeting app is muted.** Leave it unmuted. Its microphone is the virtual device, which only carries VoiceBridge's output.
4. **The translated voice goes to the speakers instead of the virtual device.** If the user hears the translation locally while the meeting's input meter stays flat, route it as in SKILL.md step 6: a Multi-Output Device with BlackHole 2ch on macOS, or the Playback tab in `pavucontrol` on Linux.
5. **The driver is installed but not active.** macOS loads BlackHole only after a restart; Audio MIDI Setup should list `BlackHole 2ch`. On Linux the null sink disappears at logout or reboot; recreate it (see the Linux section).
6. **No transcript appears.**
   - ffmpeg is missing or not found, so the app falls back to a silent mock. The log shows `[Audio] ffmpeg not found — using MockNativeAddon (no real audio)`. Install ffmpeg, or see the PATH section.
   - macOS microphone permission was denied. System Settings, Privacy & Security, Microphone: enable VoiceBridge (installed app) or the terminal app (source build), then restart VoiceBridge.
   - Settings, Microphone Input points at the virtual device or a disconnected mic. Select the real microphone or headset.
   - Voice Detection Sensitivity is too low for the room or the user speaks quietly. Raise it; lower it if background noise triggers it.
7. **API errors.** The log shows the HTTP status. See the API errors section.
8. **Windows.** The 1.0.0 installer plays no translated audio on Windows. Source builds play it through `ffplay` (or PowerShell as a fallback); this is new and untested. See the Windows section.

Browser meetings (Google Meet, Teams on the web) also need the browser's own microphone permission for the site, and the browser may remember its own device choice. Check the camera and microphone icon in the address bar.

## Wrong microphone selected

- **Participants hear the user's original voice.** The meeting app is on the real microphone, or on "Default" or "Same as system", which follow the system input. Pick the virtual device by name.
- **The selection reverts.** Some meeting apps switch devices when a headset is plugged in or a Bluetooth device connects. Re-check the microphone after any device change.
- **VoiceBridge hears nothing or loops.** VoiceBridge's own input (Settings, Microphone Input) must be the real microphone or headset. The app warns: do not select BlackHole there. Never set the virtual device as the system default input either.
- **Participants hear both voices.** Two audio paths reach the meeting, for example the meeting in a browser tab plus the desktop meeting app, or the real mic still selected in one of them. Leave one meeting client, with the virtual device as its mic.

## Hearing nothing, or echo and feedback

- **The user cannot hear the other participants.** The meeting app's speaker is set to BlackHole, CABLE Input or VoiceBridge Mic. Set it to the headphones.
- **The user does not hear their own translation.** This can be normal. When VoiceBridge plays straight into the virtual device, only the meeting hears it. With a Multi-Output Device on macOS the user also hears it in the headphones.
- **Echo, feedback or translations of the other participants.** Speakers let the real microphone pick up the other participants and the translated voice, which VoiceBridge then translates again. Fixes, in order:
  1. Use headphones.
  2. Enable Push-to-talk mode in Settings and hold Space in the VoiceBridge window only while speaking.
  3. Make sure the meeting app's speaker is not a Multi-Output Device that includes BlackHole; that sends the other participants back into the meeting.
  4. Lower Voice Detection Sensitivity in a noisy room.

## ffmpeg or sox not found when launched from Finder or the Dock

Apps started from Finder, the Dock or a Linux app menu do not get the PATH from the user's shell profile, so a tool that works in the terminal can be missing inside the app. VoiceBridge adds these folders to its own PATH: `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/snap/bin`, `/home/linuxbrew/.linuxbrew/bin`.

1. Find the tools: `command -v ffmpeg sox play` in a terminal.
2. If they are in one of the folders above, VoiceBridge finds them. Restart the app after installing.
3. If they are elsewhere (MacPorts in `/opt/local/bin`, Nix, conda, a hand-built binary), choose one, with approval:
   - install them with Homebrew (macOS) or the system package manager (Linux) so they land in a searched folder;
   - start VoiceBridge from a terminal so it inherits the shell PATH: macOS `/Applications/VoiceBridge.app/Contents/MacOS/VoiceBridge`; source builds already run from a terminal with `npm run dev`; for the Linux `.deb`, find the binary with `dpkg -l | grep -i voicebridge` and `dpkg -L <package> | grep /opt/`;
   - link the tool into a searched folder: `sudo ln -s "$(command -v ffmpeg)" /usr/local/bin/ffmpeg`, and the same for `sox` and `play`.

On Debian and Ubuntu, if `play` fails with an error about a missing handler for a file type such as mp3, install the extra formats: `sudo apt install -y libsox-fmt-all`.

## Linux: the null sink

The virtual mic on Linux is a null sink named `voicebridge`. Audio played into it comes out of its monitor source, which meeting apps list as `Monitor of VoiceBridge Mic`. These commands work on PulseAudio and on PipeWire through `pipewire-pulse`, and need no sudo.

```bash
# Create it (the app's Install Driver button runs the same command)
pactl load-module module-null-sink sink_name=voicebridge sink_properties=device.description="VoiceBridge\ Mic"

# Check it
pactl list short sinks | grep voicebridge
pactl list short sources | grep voicebridge.monitor

# Some apps hide "Monitor of" sources. Expose it as an ordinary microphone:
pactl load-module module-remap-source master=voicebridge.monitor source_name=voicebridge_mic source_properties=device.description="VoiceBridge\ Mic\ Input"

# Send only VoiceBridge's playback into the sink (or use pavucontrol, Playback tab)
pactl list short sink-inputs
pactl move-sink-input <stream-id> voicebridge

# Remove it: unload by index, so other null sinks are left alone
pactl list short modules | grep -E 'null-sink|remap-source'
pactl unload-module <module-index>
```

- If `pactl` reports a connection failure, run it from a terminal inside the desktop session, not over SSH or with sudo. On PipeWire, `systemctl --user status pipewire-pulse` should show it running.
- If loading fails because a sink with that name already exists, it is already set up; check with the commands above.
- The in-app Install buttons for ffmpeg and sox run `sudo` without a terminal and usually fail on Linux. Use the terminal commands from SKILL.md step 2.

To keep the sink after reboots, ask first, because this writes a user config file:

- PipeWire: create `~/.config/pipewire/pipewire-pulse.conf.d/voicebridge.conf` containing

  ```
  pulse.cmd = [
    { cmd = "load-module" args = "module-null-sink sink_name=voicebridge sink_properties=device.description=VoiceBridge-Mic" flags = [ "nofail" ] }
  ]
  ```

  then run `systemctl --user restart pipewire-pulse`.
- PulseAudio: create `~/.config/pulse/default.pa` with the line `.include /etc/pulse/default.pa` followed by `load-module module-null-sink sink_name=voicebridge sink_properties=device.description=VoiceBridge-Mic`, then run `pulseaudio -k` (it restarts automatically).

These files use the description `VoiceBridge-Mic` to avoid quoting problems; the sink name `voicebridge`, which VoiceBridge checks for, is the same.

## Windows: VB-CABLE

- **Translated audio needs a source build, and is untested.** The 1.0.0 installer plays no translated audio on Windows. Current source builds play it through `ffplay` (included with `winget install -e --id Gyan.FFmpeg`), or through PowerShell's sound player when ffplay is missing, to the default output device. Send it into the meeting by setting that app's output to `CABLE Input` in Settings, System, Sound, Volume mixer. Say plainly that this path is new if it misbehaves.
- **Install.** Download from https://vb-audio.com/Cable/, extract the ZIP, right-click `VBCABLE_Setup_x64.exe`, Run as administrator, Install Driver, then restart Windows. Ask before each administrator step.
- **Device names.** VB-CABLE adds a playback device `CABLE Input (VB-Audio Virtual Cable)` and a recording device `CABLE Output (VB-Audio Virtual Cable)`. Meeting apps use CABLE Output as the microphone. Do not make CABLE Input the default playback device, or every system sound goes into the meeting.
- **sox not found after `winget install -e --id ChrisBagwell.SoX`.** The package does not add SoX to PATH. Add its folder, usually `C:\Program Files (x86)\sox-14-4-2`, in System Properties, Environment Variables, then open a new terminal. SoX for Windows has no `play.exe`; the doctor reports that as a warning only.
- **ffmpeg not found after `winget install -e --id Gyan.FFmpeg`.** Open a new terminal or sign out and back in so PATH refreshes.
- **The installer is blocked.** The build is not code-signed. In SmartScreen, the user clicks More info, then Run anyway.
- **The doctor will not run.** Script execution is disabled by default on Windows. `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\doctor.ps1` relaxes the policy for that one process only.

## API errors: 401, 402, 429

The app validates keys when they are saved and logs the HTTP status of failed calls. The user fixes keys in Settings; the agent never handles them.

| Status | Usual cause | What the user does |
|---|---|---|
| 401 | Key wrong, revoked, or entered for the wrong provider (for example an OpenRouter key with the provider set to OpenAI). A restricted ElevenLabs key without the needed permissions. ElevenLabs can also return 401 with `quota_exceeded` when credits run out, or block free-tier use from VPNs and proxies. | Re-enter the key in Settings and click Validate & Save. For ElevenLabs, create a key with speech to text, text to speech, voices (write) and user (read) access. Read the message text in the log. |
| 402 | Out of credits or quota: ElevenLabs credits, OpenRouter credits, or another provider's prepaid balance. | Top up, upgrade or wait for the monthly reset, using the provider's usage page. A cheaper voice model (`eleven_flash_v2_5`) stretches ElevenLabs credits. |
| 429 | Rate or concurrency limit. ElevenLabs limits concurrent requests per plan; LLM providers limit requests per minute. OpenAI also returns 429 with `insufficient_quota` when billing has no credit. | Wait and retry, close other apps that use the same key, use push-to-talk so fewer requests overlap, or move to a higher plan. For `insufficient_quota`, add billing credit. |

A 5xx status means the provider has a problem; wait and retry, and check the provider's status page.

## Qwen3.8 LiveTranslate errors

The engine needs three values from the same Alibaba Cloud account and region: a Model Studio API key, a Workspace ID, and the region in VoiceBridge Settings (`ap-southeast-1` for Singapore or `cn-beijing` for Beijing).

- **Key rejected.** Model Studio keys belong to one region. A key created in the Singapore console fails against Beijing and the other way round. In the Model Studio console, switch to the region where the key was created, then set the same region in VoiceBridge, or create a key in the region the user wants.
- **Workspace not found or no access.** The Workspace ID is mistyped, comes from the other region, or the key was created in a different workspace. Copy the Workspace ID from the Model Studio console of the same region and use a key that belongs to that workspace.
- **Model not available.** `qwen3.8-livetranslate-flash-realtime` must be available to that workspace in that region. Check the model list in the Model Studio console.
- **Rate limited (429 or throttling).** Wait and retry; limits depend on the account.
- **Connection drops.** The engine streams audio in real time; corporate proxies and firewalls that block WebSocket traffic break it. Try another network.

Remind the user that with this engine their audio is processed by Alibaba Cloud in the chosen region.

## Local model server not reachable

For Ollama, LM Studio, vLLM or another OpenAI-compatible server set as a custom base URL:

1. **Is the server running?** These local requests are read-only:
   - Ollama: `curl -s http://127.0.0.1:11434/v1/models`
   - LM Studio: `curl -s http://127.0.0.1:1234/v1/models`
   - vLLM: `curl -s http://127.0.0.1:8000/v1/models`

   If nothing answers, start it: open the Ollama app or run `ollama serve`; in LM Studio, load a model and start the local server; for vLLM, `vllm serve <model>`.
2. **Is the model there?** Ollama: `ollama list`, and `ollama pull <model>` (a large download; ask first). The model id in VoiceBridge must match an id from `/v1/models` exactly.
3. **Is the base URL right?** It must end in `/v1`, for example `http://127.0.0.1:11434/v1`.
4. **`localhost` refused but `127.0.0.1` works.** Node.js may resolve `localhost` to the IPv6 address `::1` while the server listens on IPv4 only. Use `http://127.0.0.1:<port>/v1`.
5. **Server on another machine.** Ollama listens only on 127.0.0.1 by default. Setting `OLLAMA_HOST=0.0.0.0` on that machine exposes it to the whole network; an SSH tunnel is safer. Check the firewall.
6. **Too slow.** Small models on a CPU can add seconds per sentence. Choose a smaller or quantized model, use a GPU, or switch to a hosted provider.

For hosted OpenAI-compatible services (Groq, Together AI, DeepSeek), a 404 usually means a wrong base URL; compare it with the table in MODELS.md.

## Push-to-talk

- Enable Push-to-talk mode in Settings. Then, with translation on, hold Space while speaking and release it when done. Each press is one utterance, which avoids feedback loops and background noise when the user has no headphones.
- Space only works while the VoiceBridge window has focus. If the meeting window has focus, Space goes to the meeting app instead (Zoom, for example, uses Space as its own push-to-talk when muted). Click the VoiceBridge window first.
- Other shortcuts: Ctrl/Cmd+Shift+T toggles translation. Ctrl/Cmd+Shift+G toggles Ghost Mode for whispered speech. Ctrl/Cmd+Shift+X is the panic stop: it works from any app, stops capture, closes the connections and silences the virtual mic.
