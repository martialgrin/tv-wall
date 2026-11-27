# TV Wall

Play its own videos on each of 8 TVs (one, or several one after another), the same video on all of them, or a show that alternates the two, in sync, from a control panel on your Mac (or phone).

Your Mac runs a small server. Each TV has a Raspberry Pi 5 on its HDMI input, which opens that TV's page from the server full-screen and plays its video. Only short commands travel over the network when you switch; every TV follows the Mac's clock, so all screens stay at the same frame.

```
                    ecalevent (school Wi‑Fi)
                              │
   Mac (server) ──────────────┤
                              ├── Pi → TV 1   http://<mac-name>.local:3000/1
   Phone / laptop             ├── Pi → TV 2   http://<mac-name>.local:3000/2
   (control panel) ───────────┤   …
                              └── Pi → TV 8   http://<mac-name>.local:3000/8
```

No packages to install: you only need [Node.js](https://nodejs.org) 18 or newer, and [ffmpeg](https://ffmpeg.org) (`brew install ffmpeg`). The server uses ffmpeg to measure each video's length, so a TV with several videos knows when to move on to the next one, and to make the pictures for the phone remote. Without ffmpeg, it reads the length of MP4 and MOV files from the files themselves, and says so in the Terminal when it starts.

## 1. Start the server

The code is in a public GitHub repository, without the videos (too big for git). On a new Mac, such as the Mac mini, install [Node](https://nodejs.org) and ffmpeg (`brew install ffmpeg`), then:

```bash
git clone https://github.com/martialgrin/tv-wall.git
```

Then copy the `videos` folder over separately (USB stick, AirDrop).

1. Put your MP4 files in the `videos` folder. They are sorted by name, so `01-intro.mp4`, `02-…` give you control over the order.
2. In Terminal, from this folder:

   ```bash
   node server.js
   ```

3. It prints the address of the control panel and of each TV, for example `http://Martials-MacBook-Pro-181.local:3000/3`, then the same pages by number address.
4. The first time, macOS may ask whether `node` can accept incoming network connections: click **Allow**, or the TVs can't reach the Mac.

Leave the Terminal window open while you use the TVs. Stop the server with `Ctrl+C`.

### The Mac mini: server, and one of the TVs

The Mac mini runs the server, and its own screen can be one of the TVs:

```bash
./mac/tv.sh 8
```

That opens TV 8's page full-screen on the Mac mini, in a browser window of its own (Google Chrome, with its own profile, so your usual Chrome isn't touched). Cmd+Q leaves it. Don't open the control panel on the Mac mini during the exhibition: manage the wall from another computer or a phone (below), so the Mac mini only serves the videos and plays its TV.

To have it all start by itself, and the server start again within seconds if it ever stops:

```bash
./mac/autostart.sh install 8
```

From then on, at every login the server starts (keeping the Mac and its screen awake) and TV 8 opens full-screen. After a `git pull`, run `./mac/autostart.sh restart`; `./mac/autostart.sh status` says whether it runs; `./mac/autostart.sh uninstall` goes back to starting it by hand. Its messages go to `logs/server.log`. For a start after a power cut, also set *System Settings → Users & Groups → Automatically log in*, and *Energy → Start up automatically after a power failure*.

### The panel from your own computer

On your laptop, open the Mac mini's panel in the browser: `http://192.168.0.21:3000/` on the TP-Link's Wi‑Fi, or the Mac mini's ecalevent address (the server prints it when it starts). Don't run `node server.js` on the laptop: one server only, on the Mac mini. The panel is only a remote control: it sends commands and shows the TVs' status, and its previews are small pictures made by the server, so it takes nothing away from the TVs. In Safari, *File → Add to Dock* makes it an app of its own.

## 2. Network

The TVs' Raspberry Pis join the **TP-Link AX3000**'s own Wi‑Fi: a network of their own, not shared with the school. The TP-Link has no internet. The Mac is on both networks at once:

- **By cable to the TP-Link,** into one of its yellow LAN ports (through a USB Ethernet adapter). The TVs reach the server through it, for example at `192.168.0.21`.
- **By Wi‑Fi to ecalevent,** for the internet. In *System Settings → Network*, click **⋯**, then **Set Service Order**, and drag **Wi‑Fi** to the top. Otherwise the Mac looks for the internet through the TP-Link, which has none.
- **Give the Mac's cable a fixed address** in the TP-Link's admin page (`http://192.168.0.1`), under *Advanced → Network → DHCP Server → Address Reservation*. Otherwise the address on the cards can change after a restart.
- **Keep the Mac awake and plugged in** while the TVs play: a sleeping Mac stops the server. On a laptop, turn on *System Settings → Battery → Options → Prevent automatic sleeping on power adapter when the display is off*.

The Pis can also join **ecalevent** directly, which was how they were first set up: devices there could reach the Mac's server too. `pi/prepare-card.sh` picks the Mac's address on whichever network the Pi joins.

## 3. Set up each TV: Raspberry Pi 5 with DietPi

Each TV gets a Raspberry Pi 5 on its HDMI input. The Pi runs [DietPi](https://dietpi.com) with Chromium in kiosk mode: at every start it opens that TV's page full-screen, and the TV itself only shows its HDMI input.

**For each TV:** a Raspberry Pi 5, its official 27 W USB‑C power supply, a microSD card (16 GB or more), a micro‑HDMI to HDMI cable, and ideally a case with a fan. Use the Pi's **HDMI 0** port, next to the power socket: it also carries the sound.

### Prepare the card

1. In **Raspberry Pi Imager**, choose *Raspberry Pi 5*, then *Other general-purpose OS → DietPi → DietPi OS (64-bit)*, then the card, and write it.
2. Take the card out and put it back in the Mac. It appears as a disk, often called *NO NAME*.
3. In Terminal, from this folder, with the TP-Link's Wi‑Fi name and the TV's number:

   ```bash
   WIFI_SSID='TP-Link_1234' ./pi/prepare-card.sh 6
   ```

   It asks for that Wi‑Fi's password, then sets the card up for that TV: the page `http://<Mac's address on the TP-Link>:3000/6`, the Pi's name `tv6`, Wi‑Fi, sound over HDMI, no screen blanking. Without `WIFI_SSID`, the Pi joins ecalevent and the page uses the Mac's ecalevent address.
   - To use the Mac's name instead of its address, add it: `./pi/prepare-card.sh 6 Martials-MacBook-Pro-181.local`.
   - To replace DietPi's default login password (`dietpi`): `LOGIN_PASSWORD=… ./pi/prepare-card.sh 6`.
4. Eject the card, put it in the Pi (the slot is under the board), connect HDMI 0 to the TV, then plug in the power.

**The first start takes about 10–20 minutes:** the screen shows DietPi setting itself up and installing Chromium over ecalevent's internet, then the Pi restarts and opens the TV page. Later starts take under a minute. Each start waits up to 5 minutes for the Mac's server before opening the page, and after a power cut the Pi rejoins the others at the right frame. In the TV's own settings, choose that HDMI input at power-on and turn off sleep timers. Click **Identify TVs** in the panel to check which TV is which.

### What the script sets

- `dietpi.txt`: automatic first start, Wi‑Fi on (country CH), Chromium installed and started without a desktop (`AUTO_SETUP_AUTOSTART_TARGET_INDEX=11`) at 1920×1080, the page (`SOFTWARE_CHROMIUM_AUTOSTART_URL`), sound over HDMI (`CONFIG_SOUNDCARD=rpi-bcm2835-hdmi`), time zone Europe/Zurich.
- `dietpi-wifi.txt`: the Wi‑Fi name and password.
- `config.txt`: the Pi 5 graphics driver with HDMI sound (`dtoverlay=vc4-kms-v3d`), no screen standby (`hdmi_blanking=0`), no slow-down before 80 °C (`temp_limit=80`, instead of DietPi's 65 °C).
- `cmdline.txt`: the start-up screen in 1080p on both ports (`video=HDMI-A-1:1920x1080@60 video=HDMI-A-2:1920x1080@60`).
- `Automation_Custom_Script.sh` (from `pi/`), which DietPi runs once after its first-start installs. It lets Chromium play sound without a click (`--autoplay-policy=no-user-gesture-required`, tested with the TV page: without it the TV reports *Sound blocked*). It also turns off error dialogs and prompts, makes Chromium wait for the server, keeps the screen from ever blanking, and installs Bonjour so the Pi answers to `tv6.local`. Finally, it sets the display to 1080p (`/etc/X11/xorg.conf.d/20-tvwall-1080p.conf`). Otherwise a 4K TV gets 3840×2160, and Chromium's 1920×1080 window fills only a quarter of it. 1080p is also lighter for the Pi, and the TV scales it up.

### Change something later

- **Another Wi‑Fi, or another page address,** on a Pi that has already started: put its card in the Mac and run the same command, for example `WIFI_SSID='TP-Link_1234' ./pi/prepare-card.sh 6` (it asks for the password), or `./pi/prepare-card.sh 6 <new address>`. The script puts the changes on the card; at its next start the Pi applies them, deletes the file with the password, and restarts by itself.
- **The page, by hand:** edit the `SOFTWARE_CHROMIUM_AUTOSTART_URL=` line in `dietpi.txt` on the Pi: `ssh root@tv6.local` (password `dietpi` unless you chose one), then `nano /boot/dietpi.txt` and `reboot`. DietPi reads it at every start. After the first start, `dietpi.txt` is no longer on the card's disk, so this can't be done from the Mac's card reader.
- **Display settings** (1080p, graphics driver, no standby): put the card in the Mac and run `./pi/prepare-card.sh <TV number>` again. On a card that has already started, it doesn't ask for the Wi‑Fi password. The 1080p setting has to go on the card's Linux part, which the Mac can't write, so the script puts a small one-time script (`tvwall-once.sh`) on the card instead. The Pi runs it at its next start, the way Raspberry Pi Imager applies its settings, then restarts by itself.
- **Chromium's options:** `/etc/chromium.d/tvwall` on the Pi.
- **The login password:** `passwd`, over SSH.

### Playback on the Pi 5

The Pi 5 has no hardware decoder for H.264, so Chromium decodes the videos on its processor. That is enough for 1080p at 25–30 fps, which is what `convert.sh` makes; avoid 4K and 60 fps. A TV's card shows *% frames dropped* when it drops more than 2% of its frames. If a Pi only drops frames while switching (it decodes two videos at once for about 1.5 s), tick *One video at a time* on its card. Rotation from the panel is done by the Pi's graphics chip.

## 3b. Samsung TV Wall app (not used)

**Not used:** the wall now uses Raspberry Pis (section 3). The app's files stay in the project for reference; nothing runs them unless a Samsung display installs the app.

Samsung signage displays play badly in their Web Browser. They have one video decoder, they can't rotate video, and their browser engine is old. On a QM50R-B, portrait files played at 0.92× real time and every jump froze the picture for 1.5–3 s. Use the **TV Wall app** instead: it plays through Samsung's own video player (AVPlay), and the control panel treats the display like any other TV.

The app is a small shell you sign and install once. Each time it starts, it loads the player (`public/samsung.js`) from the Mac, so a change to the player only needs **Reload TVs**, not a new install.

### One time: make a Samsung certificate

The display only installs apps signed with your own Samsung certificate, made for that display.

1. In Visual Studio Code, install Samsung's **Tizen Extension** (`tizen.vscode-tizen-csharp`; search for "Tizen Extension" in Extensions). Not the older "tizentv" one: it can't make Samsung certificates.
2. Open the command palette (`Cmd+Shift+P`) and run **Tizen: Install Tizen CLI**. If the extension asks to install more packages (for example in **Tizen: Package Manager**), accept.
3. On the display, turn on developer mode: *Home → URL Launcher Settings → Developer Mode → On*, enter the Mac's address (`192.168.0.10`), then restart the display.
4. Run **Tizen: Remote Devices** (or **Tizen: Device Manager**) and add the display's address, so the tools connect to it and can read its ID (DUID).
5. Run **Tizen: Create Certificate** and make a profile named `tvwall`: choose **Samsung** (not Tizen), then **TV**. It asks you to sign in with a Samsung account. For the distributor certificate, choose the privilege level **Public**, and refresh the DUID list so it includes the display. With several Samsung displays, include each one's DUID.

The menu names differ a little between firmware versions and tool versions.

### Build and install the app

1. In Terminal, from this folder:

   ```bash
   ./samsung/build.sh tvwall 192.168.0.10:3000
   ```

   This signs the app with the `tvwall` profile and makes `samsung/TVWall.wgt`, which the server offers to the displays straight away. A `TVWall.wgt` built in `samsung/app` with VS Code works too: the server uses whichever is newer.
2. On the display: *Menu → System → Play Via → URL Launcher*.
3. *Home → URL Launcher Settings → Install Web App*, enter `http://192.168.0.10:3000/samsung`, then *Done*.
4. The app starts and asks which TV it is: press the number on the remote (or ▲ ▼), then OK. The red **A** button brings this screen back.

The display then starts the app by itself whenever it's turned on. Rotation from the panel is done by Samsung's player, so it costs nothing; *One video at a time* is not needed, since the app always plays one video.

**How it stays in sync:** Samsung's player can't play slightly faster or slower, so the app starts at the shared start time, then corrects by jumping ahead, or by pausing a moment when it's ahead. It learns how long this display takes to start, jump and resume. At the end of each loop it jumps back to the start, and the picture freezes for as long as a jump takes on that display. Longer videos loop less often.

If something goes wrong, the TV's card shows the error. Its recent events are in the server's state (`/api/state`, under `status`), which helps to see what happened on the display.

## 4. Use the control panel

Open `http://<mac-name>.local:3000/` on the Mac, or on your phone if it's on ecalevent too.

| Control | What it does |
|---|---|
| **Expo: own videos per TV** | Each TV plays its own list of videos, shown on its card. |
| **Same video on all TVs** | Every TV plays the video chosen at the top. Clicking a video in the *Videos* list does the same. |
| **Show: videos in turn + Expo** | Every TV plays the same video, one after another through the show's list; after the last one, Expo for 10 minutes (each TV its own videos, as on its cards); then the list again, and so on. TVs with *Keep its own videos* (the credits) stay on their own videos throughout. In the Show box: the show's videos (+ *Add a video*, ×, *All videos*), the Expo minutes, where the show is now, and *Videos now* / *Expo now* to jump. Changing the list or the minutes starts the show again from its first video. |
| *+ Add a video…* on a TV | Adds a video at the end of that TV's list. The TV plays its videos one after another (1, 2, 1, 2…) and starts again from the first after the last. A list of one video loops it. The numbers on the card give the order; the video on screen now is highlighted. |
| × on a video in a TV's list | Removes it. With no video left, the TV shows black. |
| **Fill in order** | TV 1 plays the first video, TV 2 the second, and so on (one video each, in place of their lists). |
| **Restart in sync** | Every TV restarts from the beginning (the first video of its list), all together. |
| **Identify TVs** | Shows each TV's number on its screen. |
| **Reload TVs** | Reloads the page on every TV (useful after changing settings). |
| **Rotate all** | Turns the picture on every TV a quarter turn clockwise. |
| Rotate button on a TV (↻ 0°) | Turns that TV's picture a quarter turn clockwise: 0°, 90°, 180°, 270°. The card's preview turns too, so it shows what the screen displays. The video keeps playing, in sync. |
| *Keep its own videos* on a TV | In *Same video on all TVs* and *Show* modes, that TV keeps playing its own list while the others play the shared videos: tick it on the credits TV. Its list stays editable, and its card has an orange outline. The phone remote's *Same video* follows this too. |
| *One video at a time* on a TV | For a TV that stutters while switching: a Raspberry Pi that drops frames then, or a display that can decode only one video at once. That TV stops the current video and loads the next one in its place, instead of loading it alongside. The picture pauses for about 1.5 s at each switch, then starts with the other TVs. A single video loops in place on that TV. Leave it off on TVs that play smoothly. |
| *Sound on this computer* | Plays the sound of the chosen TV's video on the computer showing the panel, in sync with the TVs (see below). |
| Speaker icon on a TV | Turns that TV's sound on or off. In *Same video on all TVs* mode, turn sound on for only one TV: the same audio from 8 speakers sounds like an echo. |

Switching between the modes keeps each TV's list, so you can go back and forth. Changing a TV's list starts it again from its first video. All TVs with the same list change video at the same moment.

### Phone remote

A simpler page for an iPhone, for use during the exhibition: `http://<mac-name>.local:3000/remote` (the panel lists it under *TV addresses*). The phone must be on the same network as one side of the Mac: the TP-Link's Wi‑Fi or ecalevent. In Safari, *Share → Add to Home Screen* gives it an icon and opens it full-screen like an app.

| Control | What it does |
|---|---|
| **Sound on / Sound off** | Silences or un-silences every TV at once. Each TV keeps its own speaker setting for when the sound comes back. |
| TV numbers under it | Which TVs play sound: tap a number to turn that TV's speaker on or off. In *Same video* mode, choose one TV to avoid an echo. |
| **Expo** | Each TV plays its own videos, as set in the full panel. |
| **Same video** | Every TV plays the same video. |
| **Show** | The show, as set in the full panel: the same videos in turn, then Expo. The line under the buttons says where it is. |
| A video in the grid | Plays that video on every TV, together. Tap it again to restart it. |
| **Restart in sync** | Every TV restarts its video from the beginning, together. |

The pictures of the videos are made by the Mac with ffmpeg the first time they're needed, and kept in `thumbs/`. While the sound is off from the remote, the full panel says so above the TV cards, with a button to turn it back on.

### Sound on a soundbar, from the Mac

The **Sound on this computer** box plays one TV's sound on the computer where you open the panel, for example the Mac connected to a soundbar.

1. Connect the soundbar to the Mac (cable, Bluetooth or AirPlay), and choose it in *System Settings → Sound → Output*. With AirPlay, use Safari for the panel: Chrome-based browsers such as Brave can make the Mac drop the AirPlay speaker.
2. In the panel, under **Sound of**, choose the TV whose video you want to hear, then click **Play**. The sound follows that TV: when its video changes or restarts, or its list moves on to the next video, the sound changes with it.
3. If the sound comes late compared with the picture, set **Soundbar delay**: about 150–250 ms for Bluetooth, about 2000 ms for AirPlay, 0 for a cable. The sound is then sent that much earlier.

The sound keeps to the TVs' clock like a TV does: tiny speed changes, or a jump when it's far off. The box shows how far off it is. Only the device where you click **Play** plays sound, so the panel can stay open on your phone too, and if the panel is open in two tabs of one browser, only the last one started plays. The choice, volume and delay are remembered on that device. After the page reloads, the browser may want one more click on **Play**. Turn the TVs' own sound off (speaker icons) to avoid an echo.

Each TV card shows whether the TV is online, what it's playing, how far it is from perfect sync, and the share of frames it drops if that's above 2%. The TV corrects itself by playing slightly faster or slower; a few milliseconds is normal.

Videos you add to, or remove from, the `videos` folder appear in the panel within a second. If you replace a file that's playing, the TVs reload it.

### Crash test

The **Crash test** box in the panel checks the whole wall and writes down everything it sees. Before starting it, click **Reload TVs** once after updating the code, so every TV runs the latest page: the box names the TVs that don't yet.

Put the wall in the mode it will be in (the **Show**, for the exhibition) before starting: the test puts it back that way, and watches it until the end.

1. Choose a **Length** (10 minutes to 8 hours) and the **Controls**, then click **Start test**. For a night before an opening: **Hard**, 3 hours or more, with the wall in Show mode, so the long run goes through many rounds of the show.
2. It watches the wall as it is for 2 minutes. Then it tries the controls:
   - **Normal** (about 5 minutes): restart in sync, the same video on all TVs, quick changes one every 1.5 s, and a reload of the TVs.
   - **Hard** (about 10 minutes): the same, plus:
     - the show's two changes (videos → Expo, Expo → videos), as they happen by themselves;
     - a storm of changes between every mode, one a second;
     - every connection to the server cut at once, as a Wi‑Fi drop would;
     - the server frozen for 3 s;
     - a second reload.
   - **Watch only:** changes nothing.

   After that it puts the wall back exactly as it was and keeps watching until the end. Sound is never touched. Don't change the wall meanwhile: the test notes it if you do.
3. At the end, the box gives each TV a result: **OK**, **Check** or **Problem**. The results come with notes, such as *Went offline 2×*, *Lost 8% of its messages*, *Didn't get back in sync after: Reload the TVs*. *What happened* lists every event with its time.

The test runs in the server, so you can close the panel and come back. **Stop test** ends it early, keeps its log, and puts the wall back. Each test's log is in the `logs` folder next to `server.js`: `test-<date>.jsonl`, with one line per second for every TV (state, video, how far off, Wi‑Fi reply time, video loaded ahead, memory). The panel lists the last ten logs to download. That file is what to send for a closer look.

To get the logs on another computer, such as a laptop on the TP-Link's Wi‑Fi, run this in its copy of the project:

```
./fetch-logs.sh
```

It copies every log from the server at 192.168.0.21 into that computer's `logs` folder, skipping the ones it already has. From ecalevent, give the server's address or name there, which the server prints when it starts: `./fetch-logs.sh <address>`.

Hovering a TV's dot also shows how fast the server answers it, and the share of its reports lost since its page loaded.

## Video format

Not every player can decode every file, and 4K is too heavy for the TVs and the Pis. Use **MP4, H.264, at most 1920 px on the long side, 30 fps or less, with a keyframe every second**, and AAC audio. A file a TV can't play shows *"Can't play …"* on that TV.

Keyframes matter for sync: to put a late TV back at the right moment, the page jumps to that point in the video, and a TV can only jump quickly when there's a keyframe close by. Phone and camera files often have one every 5–10 seconds, or only one at the start.

The simplest way is to run every video through `convert.sh` (needs [ffmpeg](https://ffmpeg.org): `brew install ffmpeg`). It keeps the orientation (1920×1080 landscape or 1080×1920 portrait), adds a keyframe every second, and writes the result into `videos/`:

```bash
./convert.sh originals/*.mp4
```

Keep your untouched files in `originals/` and only converted ones in `videos/`. Each TV loads its next video, or the next round of a single video, 2 seconds ahead in a second player, and cuts to it at its first frame, together with the other TVs. A video whose last frame matches its first frame then loops seamlessly. A TV playing a single video downloads it once and keeps it in memory, so the following rounds don't use the Wi‑Fi (the Android displays' own cache is too small for a video: without this, each one downloaded about 10 Mbit/s nonstop). Hovering a TV's dot in the panel shows *Video in memory:* and the video's name once it's done. Videos under 5 seconds, and TVs with *One video at a time*, loop in place instead: some TVs (the Android displays) take 0.3–0.4 s to jump back to the start, then play faster for a few seconds to catch up, which you can hear on a TV with sound.

For vertical videos on TVs mounted in portrait, use the rotate button on each TV card (90° or 270°, depending on which way the TV is turned). The vertical video then fills the whole screen. On the Raspberry Pis, the graphics chip does the turning. (A TV's own browser can find this heavy: a Samsung TV dropped to 1–2 frames per second at 270°.)

To check sync on site, make a test clip with a frame counter and play it on all TVs. Every screen should show the same frame number:

```bash
ffmpeg -f lavfi -i "testsrc2=s=1920x1080:r=25:d=60" -vf "drawtext=text='%{pts\:hms}  frame %{frame_num}':fontsize=90:fontcolor=white:box=1:boxcolor=black:x=(w-tw)/2:y=h-200" -c:v libx264 -pix_fmt yuv420p -movflags +faststart videos/sync-test.mp4
```

## Settings

Set these before `node server.js`, for example `SCREENS=4 PORT=8080 node server.js`.

| Variable | Default | What it sets |
|---|---|---|
| `SCREENS` | `8` | Number of TVs |
| `PORT` | `3000` | Server port |
| `VIDEOS_DIR` | `./videos` | Folder with the videos |
| `START_DELAY` | `1500` | Milliseconds between a click and the synchronized start. Raise it if some TVs start late on a slow network. |

The current choices are saved in `state.json`, so a restart of the Mac or the server picks up where you left off. Delete that file to reset.

## Troubleshooting

| Problem | Fix |
|---|---|
| A Pi shows *This site can't be reached*, or a black screen | It can't reach the page. Check that the server is running, that the Pi's address for the page (`SOFTWARE_CHROMIUM_AUTOSTART_URL` in `/boot/dietpi.txt` on the Pi) matches one the server prints, and that macOS allowed incoming connections for `node` (*System Settings → Network → Firewall → Options*). Open the same address on your phone first, then restart the Pi. |
| The page fills only a quarter of the screen | The TV is 4K and the Pi's display runs in 4K, while Chromium's window is 1080p. Cards prepared since 29 October set 1080p themselves. For a Pi set up earlier, either put its card in the Mac and run `./pi/prepare-card.sh <TV number>` (at its next start the Pi applies 1080p, restarts by itself, then opens its page), or, with the Pi on, run `ssh root@tv6.local 'bash -s' < pi/set-1080p.sh` (password `dietpi`). |
| A Pi shows DietPi's text screen for more than 20 minutes | It isn't on the Wi‑Fi, or can't download Chromium. Prepare the card again with `./pi/prepare-card.sh` and check the Wi‑Fi password. |
| The TV card says *Offline* but the TV shows the video | The TV lost its connection to the server. It keeps playing and reconnects on its own. |
| *Sound blocked* on a TV | Chromium was started without permission to play sound on its own. The card script gives it (section 3); check `--autoplay-policy=no-user-gesture-required` in `/etc/chromium.d/tvwall` on the Pi. |
| *% frames dropped* on a TV | That Pi can't decode fast enough. Check that the video was made with `./convert.sh` (1080p, 30 fps or less). If it only happens while switching, tick *One video at a time* on that TV. |
| A TV is often *ms off*, freezes, or drops *Offline* for a minute | The Wi‑Fi is weak where that Pi is. Check it from the Mac with `ping 192.168.0.x` (the TV's address, shown when hovering its dot): a good link loses no replies. Use an Ethernet cable to one of the TP-Link's LAN ports, or move the Pi out from behind the TV, or the TP-Link closer. If a round of a single video isn't loaded in time, the TV goes back to the start of the video on screen instead. |
| A Mac or laptop used as a TV disappears | It went to sleep, or left the TP-Link for a Wi‑Fi with internet. On that Mac, untick *Auto-Join* for the other networks (*System Settings → Wi‑Fi → ⋯ next to the network*) and keep it awake on power, as in section 2. |
| *Can't play …* on a TV | The TV can't decode that file (often 4K or ProRes). Convert it with `./convert.sh`. The exact reason also appears in the Terminal where the server runs. |
| A TV follows commands a second late | Some browsers hold back live updates. The TV then picks up each change from its own once-a-second report instead, so it switches up to a second later but stays in sync. Nothing to fix. |
| *ms off, correcting* never settles, or the picture keeps jumping | Convert the video with `./convert.sh`: without a keyframe every second, some TVs take seconds to jump to the right point. If the TV is rotated in the panel, try it at 0°. Hovering the TV's dot in the panel shows how long its jumps and starts take; each TV learns both and allows for them. |
| A TV with several videos only plays the first one, or the Android displays fall behind for a few seconds each time a single video starts again | The server couldn't measure the videos' lengths: a file isn't MP4 or MOV and ffmpeg isn't installed (`brew install ffmpeg`, then restart the server), or a file is damaged (convert it with `./convert.sh`). The TVs then loop each video on their own, which the Android displays do slowly. |
| *Open on 2 devices* on a TV card | The same TV address is open in two places, for example on the TV and in a tab on your Mac. Close the extra one: their reports mix. |

## Files

- `server.js`: the server (videos, control commands, live updates, saved state)
- `convert.sh`: converts videos into a format every TV can play
- `pi/prepare-card.sh`, `pi/Automation_Custom_Script.sh`: set up a DietPi card for one TV's Raspberry Pi
- `pi/tvwall-once.sh`: put on an already-started card by `prepare-card.sh`; the Pi runs it once at its next start to switch to a 1080p display
- `pi/set-1080p.sh`: the same switch, run on a Pi over SSH
- `originals/`: your untouched source videos
- `public/player.html`, `public/player.js`: the page each TV shows
- `public/schedule.js`: works out which video of a TV's list plays at a given moment (shared by the TVs and the panel)
- `public/control.html`, `public/control.js`, `public/control.css`: the control panel
- `public/computer-sound.js`: the panel's *Sound on this computer* box
- `public/remote.html`, `public/remote.js`, `public/remote.css`, `public/remote-icon.png`: the phone remote
- `thumbs/`: pictures of the videos for the phone remote, made automatically
- `logs/`: the crash tests' logs (not in git)
- `fetch-logs.sh`: copies the crash tests' logs from the server to another computer
- `mac/tv.sh`: shows one TV's page full-screen on a Mac (the Mac mini)
- `mac/autostart.sh`: starts the server, and that TV page, by themselves at login
- Not used (section 3b): `public/samsung.js`, the player for Samsung displays; `samsung/app/`, the Samsung app; `samsung/build.sh`, which signs it
- `videos/`: your videos
