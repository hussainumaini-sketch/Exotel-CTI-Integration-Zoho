# Exotel CTI for Zoho CRM

Exotel calling inside Zoho CRM. Agents place and take calls from a phone bar
docked on Leads, Contacts, Accounts and Deals, or from a Call button on a
record. Every call is logged in Zoho's Calls module with its disposition and
recording, and incoming calls are routed to the right person.

Everything runs inside Zoho (widgets, Deluge functions and Client Scripts),
so no separate server has to be hosted.

## Setting it up

There are two ways, and both start in this folder.

- **By hand:** open `Zoho-CTI-Setup-Guide.pdf` and follow it from Part I.
- **With an AI assistant:** open Claude Code, Claude Cowork or Codex in this
  folder and type `Set up the Exotel CTI in my Zoho CRM`. The assistant
  follows `zoho-cti/SETUP-PLAYBOOK.md`: it asks for each credential one at a
  time, runs the scripts, and does or explains the Zoho and Exotel website
  steps.

The steps in short:

1. `npm install`, copy `.env.example` to `.env` and fill in the Exotel and
   Zoho credentials.
2. `npm run provision`, then `npm run zoho:auth -- <code>`, then
   `npm run zoho:cti-setup`.
3. In Zoho: the `cti_crm` connection, the three functions, the four widgets,
   the Call and Call history buttons, the CTI Admin and Phone web tabs, and
   the Client Scripts.
4. In Exotel: a flow whose Passthru and Connect applets point at
   `cti_webhook` and `cti_route`, assigned to the ExoPhone.
5. Turn people on in the CTI Admin tab, then test a call each way.

The files Zoho needs are already built in `out/`, so nothing has to be built
unless the code changes.

## Requirements

- Node.js 20 or newer on the computer that runs the setup.
- Zoho CRM with Developer Hub access (widgets, functions, Client Scripts).
- An Exotel account with WebRTC calling enabled. The customer Client ID and
  Client Secret come from the Exotel account manager.

## How agents use it

- **Desktop or Phone**, at the top of the phone. Desktop takes calls in and
  out on the browser SIP line. Phone places calls out on SIP and rings the
  agent's own mobile for calls in.
- **Settings** (gear icon) choose SIP or the agent's Number for outgoing
  calls.
- **Caller ID** is always one of the account's ExoPhones, never the agent's
  personal number.
- **Dispositions** are saved in Zoho's standard `Call_Result` field, with
  `Sub_Disposition` and `Disposition_Note` for detail. The administrator
  edits the list on the CTI Admin tab.
- **Incoming calls** ring the record owner first, otherwise the next agent
  in turn. A caller who is not in Zoho becomes a new Lead, and a Zoho Signal
  tells the agent's phone who is calling.

## What is in this repository

| Path | What it is |
|---|---|
| `START-HERE.txt` | The two ways to set it up, in a few lines |
| `Zoho-CTI-Setup-Guide.pdf` | Step by step guide for a manual setup |
| `zoho-cti/SETUP-PLAYBOOK.md` | The same steps written for an AI assistant |
| `CLAUDE.md`, `AGENTS.md` | Point AI assistants to the playbook |
| `zoho-cti/widget/` | Source of the screens Zoho hosts as widgets |
| `zoho-cti/functions/` | The three Zoho Deluge functions |
| `zoho-cti/client-scripts/` | Eight Client Scripts that open the docked phone bar |
| `scripts/`, `provision.js`, `build-sdk.js`, `zoho.js` | Setup and build scripts |
| `public/vendor/exotel-websdk.bundle.js` | The bundled Exotel WebSDK, used for browser (SIP) calls |
| `out/zoho-cti-widget.zip` | Ready built widget, uploaded in Zoho Widgets |
| `out/zoho-functions/*.txt` | Ready built function code, pasted into the three functions |
| `.env.example` | Template for the credentials (placeholders only) |

### Widget screens (`zoho-cti/widget/app/`)

| File | What it does |
|---|---|
| `cti.html`, `cti.js`, `cti.css` | The phone: dial, answer, hang up, mute, hold, keypad (DTMF), call timer and the disposition form after each call. The same page runs as the Call button popup, the docked phone bar and the Phone web tab. The build also produces `phone.html` and `history.html` from it. |
| `admin.html`, `admin.js` | The CTI Admin tab. Lists every Zoho user; the administrator turns calling on, enters the person's mobile number, and their Exotel SIP line is created there and then. Also holds the dispositions and the unknown caller setting. |
| `bridge.html` | Lets the Call button popup, the docks and an open Phone tab share one SIP line over a BroadcastChannel. |
| `cti-common.js` | Shared helpers. |
| `cti-sounds.js` | Ringtone and call tones. |
| `cti-timers.js` | Timers that run on a worker, so a background tab is not throttled. |
| `../plugin-manifest.json` | The Zoho widget manifest. |

The four widgets made from `out/zoho-cti-widget.zip`:

| Name | Type | Index page |
|---|---|---|
| Exotel CTI | Button | `/cti.html` |
| CTI History | Button | `/history.html` |
| CTI Admin | Web Tab | `/admin.html` |
| Exotel Phone | Web Tab | `/phone.html` |

### Zoho functions (`zoho-cti/functions/`)

| Function | Access | What it does |
|---|---|---|
| `cti_api` | OAuth2 | The API the widgets call. Places calls through Exotel, reports call status, fetches recordings, creates SIP lines and keeps each agent's Exotel devices in step with their settings. |
| `cti_webhook` | API key | Receives Exotel status callbacks and the flow Passthru events (incoming, connected, missed) and writes the Zoho Call log, with the disposition and the recording attached. |
| `cti_route` | API key | Called by the Exotel Connect applet to decide who to ring: the record owner first, otherwise round robin; the SIP line first with the agent's phone as fallback. Creates a Lead for an unknown caller and raises the Zoho Signal. |

### Scripts

| Command | File | What it does |
|---|---|---|
| `npm run provision` | `provision.js` | Registers the Exotel app (writes `EXOTEL_APP_ID` and `EXOTEL_APP_SECRET` into `.env`) and turns call recording on. |
| `npm run zoho:auth` | `scripts/zoho-auth.js` | Connects to a Zoho CRM org with a Self Client code and stores the refresh token in `.env`. |
| `npm run zoho:cti-setup` | `scripts/zoho-cti-setup.js` | Creates the CTI Agents module, the call fields and dispositions, and the Zoho org variables that hold the Exotel settings. Safe to run more than once. |
| `npm run zoho:widget` | `scripts/build-zoho-widget.js` | Builds `out/zoho-cti-widget.zip` and the three files in `out/zoho-functions/`. |
| `npm run build:sdk` | `build-sdk.js` | Bundles the Exotel WebSDK into `public/vendor/`. Runs by itself after `npm install`. |

`zoho.js` is the Zoho CRM API client the scripts share.

## Security

No credentials are stored in this repository. Real keys go only into `.env`,
which `.gitignore` keeps out of git. Never email that file or share
screenshots of it. The function URLs that carry API keys are secrets too and
are not stored here.
