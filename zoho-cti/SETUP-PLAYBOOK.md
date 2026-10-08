# Exotel CTI for Zoho CRM: setup playbook for an AI assistant

This file is for Claude Code, Claude Cowork, Codex or any AI assistant asked
to set up the Exotel CTI in someone's Zoho CRM. The person you are helping
is usually not technical. The PDF guide (Zoho-CTI-Setup-Guide.pdf) has the
same steps for people doing it by hand.

## How to work

1. **Collect the credentials first.** Before doing anything else, ask for
   every credential in the table under "The credentials", one question per
   message, in that order. Say where to find each one (the "Where" column),
   wait for the answer, write it into `.env`, then ask the next. Never ask
   for several in one message. Only then start the steps.
   Three things can't be collected up front, and are asked for when the
   step comes: the Zoho one-time code (it expires in 10 minutes, Step 2)
   and the two function addresses Zoho makes in Step 5.
2. **Don't ask for the virtual number (ExoPhone).** The setup reads the
   account's ExoPhones from Exotel, and the CTI Admin tab offers them. A
   number removed from Exotel is replaced by the first one left, by itself.
3. **Do every step you can yourself.** Editing `.env`, running the npm
   scripts and reading their output are always yours.
4. **Website steps.** Some steps happen in the Zoho or Exotel website. If you
   can operate their browser (for example Claude in Chrome, or Cowork's
   browser), ask them to log in to Zoho CRM (as an administrator) and to the
   Exotel dashboard, then do those steps yourself and say what you did. If
   you can't, give one short numbered list for that step only, with the
   exact names to type, then stop and wait until they say it is done (or
   paste what the step asks for).
5. Never repeat a secret back in chat, never put one in a commit, in a file
   other than `.env`, or in a screenshot request.
6. After every command, read its output. A cross, "Missing" or "Error" means
   stop, explain it in one or two plain sentences, and fix it before going
   on.
7. Keep a running checklist in chat: what is done, what is next.
8. Work from the folder with `package.json`.

## The credentials (ask in this order, one at a time)

| # | Ask for | .env name | Where they find it |
|---|---|---|---|
| 1 | Exotel Account SID | `EXOTEL_ACCOUNT_SID` | Exotel dashboard, "API Credentials" at the top (also Settings > API Settings) |
| 2 | Exotel API Key | `EXOTEL_API_KEY` | Same page |
| 3 | Exotel API Token | `EXOTEL_API_TOKEN` | Same page |
| 4 | Region | `EXOTEL_SUBDOMAIN` | Ask "Is your Exotel account in India (Mumbai)?" India: `api.in.exotel.com`. Singapore: `api.exotel.com` |
| 5 | Exotel Client ID (customer credential) | `EXOTEL_CLIENT_ID` | Sent by their Exotel account manager for WebRTC calling |
| 6 | Exotel Client Secret (customer credential) | `EXOTEL_CLIENT_SECRET` | Same document |
| 7 | Which Zoho site they log in to | (decides the API console address) | zoho.in (India), zoho.com (US), zoho.eu, zoho.com.au |
| 8 | Zoho Self Client ID | `ZOHO_CLIENT_ID` | `api-console.zoho.<their ending>` > Add Client > Self Client > Create > "Client Secret" tab |
| 9 | Zoho Self Client Secret | `ZOHO_CLIENT_SECRET` | Same tab |

Then set these yourself without asking:

- `EXOTEL_ICORE_BASE=https://integrationscore.mum1.exotel.com` (India; ask
  Exotel for the address in other regions)
- `EXOTEL_APP_NAME=Zoho CTI`
- Leave `EXOTEL_CALLER_ID`, `EXOTEL_APP_ID`, `EXOTEL_APP_SECRET`,
  `EXOTEL_WEBRTC_USER_ID`, `EXOTEL_AGENT_NAME` and `EXOTEL_AGENT_NUMBER`
  empty.

## Step 0: the computer

- Check `node -v` prints v20 or newer. If not, ask them to install the LTS
  version from nodejs.org, then continue.
- Run `npm install`.
- If `.env` does not exist, copy `.env.example` to `.env` (before asking for
  the credentials).

## Step 1: register the Exotel app

Run `npm run provision`. It registers the Exotel app, writes
`EXOTEL_APP_ID` and `EXOTEL_APP_SECRET` into `.env`, and turns call
recording on. A warning that `EXOTEL_WEBRTC_USER_ID` is empty is expected:
people get their SIP lines later from the CTI Admin tab.
If it says "trial account", Exotel has not enabled WebRTC users on this
account yet; tell them, and stop until it is enabled.

## Step 2: connect this computer to their Zoho CRM

1. In the same Self Client, "Generate Code": Scope
   `ZohoCRM.settings.ALL,ZohoCRM.modules.ALL,ZohoCRM.users.READ,ZohoCRM.org.READ`,
   10 minutes, any description, Create, their CRM organisation. Ask them to
   paste the code (or read it yourself if you operate the browser).
2. Run `npm run zoho:auth -- <code>` at once. It writes `ZOHO_ACCOUNTS_URL`
   and `ZOHO_REFRESH_TOKEN`.
3. Run `npm run zoho:cti-setup`. It creates the "CTI Agents" module and its
   fields, the call fields and dispositions, and stores the Exotel settings
   as Zoho org variables. It must end with "Done".

## Step 3: build the files Zoho needs

Run `npm run zoho:widget`. It writes `out/zoho-cti-widget.zip` (the CTI
screens) and `out/zoho-functions/cti_api.txt`, `cti_webhook.txt`,
`cti_route.txt` (the server code, ready to paste). The kit ships with these
already built.

## Step 4: the connection (Zoho website)

Made by a Zoho administrator: the CTI reads and saves every person's
calling settings through it, so RMs need no access of their own to the CTI
Agents module, whatever the org's sharing rules.

Setup > Developer Hub > Connections > Create Connection: service Zoho
OAuth; Connection Name `cti_crm` (the link name must be exactly `cti_crm`);
scopes `ZohoCRM.users.ALL`, `ZohoCRM.modules.ALL`,
`ZohoCRM.settings.variables.ALL`, `ZohoCRM.settings.fields.ALL`; Create and
Connect, then Accept.

## Step 5: the three functions (Zoho website)

For each of `cti_api`, `cti_webhook`, `cti_route`, in that order:

1. Setup > Developer Hub > Functions > New Function. Function Name and
   Display Name: the name exactly. Category: Standalone. Create.
2. In the editor select everything and paste the whole of
   `out/zoho-functions/<name>.txt`. Save. If Zoho will not accept the first
   line: Edit Arguments, add one argument `crmAPIRequest` of type Map, then
   paste only what is between the first `{` and the last `}`.
3. On the function list, its menu > REST API: `cti_api` OAuth2 ON, API Key
   OFF. `cti_webhook` and `cti_route`: API Key ON, and get the API Key URL
   (ask them to paste it, or copy it yourself).
4. With the `cti_webhook` URL run
   `npm run zoho:cti-setup -- --webhook "<that URL>"`. Keep the `cti_route`
   URL for Step 9. Both are secrets.

## Step 6: the widgets (Zoho website)

Setup > Developer Hub > Widgets > Create New Widget, four times, Hosting
Zoho, uploading `out/zoho-cti-widget.zip`:

| Name (exactly) | Type | Index page |
|---|---|---|
| Exotel CTI | Button | /cti.html |
| CTI History | Button | /history.html |
| CTI Admin | Web Tab | /admin.html |
| Exotel Phone | Web Tab | /phone.html |

The first one's API name must come out as `Exotel_CTI` (the docked phone
opens it by that name).

## Step 7: buttons and tabs (Zoho website)

1. Setup > Customization > Modules and Fields > Leads > Buttons > Create
   New Button: `Call`, on the record's details page, action Widget, Exotel
   CTI, all profiles. A second one: `Call history`, widget CTI History.
2. The same two buttons on Contacts.
3. Setup > Modules and Fields > Web Tab > New Web Tab: `CTI Admin`, type
   Widget, CTI Admin, Administrator profile only.
4. Another Web Tab: `Phone`, type Widget, Exotel Phone, all profiles. It is
   a keypad for calling any number, also from the Zoho phone app.

## Step 8: the docked phone (Zoho website)

Eight Client Scripts, one per file in `zoho-cti/client-scripts/`.
Setup > Developer Hub > Client Script > New Script:

| File | Module | Page | Event |
|---|---|---|---|
| Leads-list-page.js | Leads | List Page (Standard) | Page Event > onCustomViewLoad |
| Leads-detail-page.js | Leads | Detail Page (Standard) | Page Event > onLoad |
| Contacts-list-page.js | Contacts | List Page (Standard) | onCustomViewLoad |
| Contacts-detail-page.js | Contacts | Detail Page (Standard) | onLoad |
| Accounts-list-page.js | Accounts | List Page (Standard) | onCustomViewLoad |
| Accounts-detail-page.js | Accounts | Detail Page (Standard) | onLoad |
| Deals-list-page.js | Deals | List Page (Standard) | onCustomViewLoad |
| Deals-detail-page.js | Deals | Detail Page (Standard) | onLoad |

Name each "Exotel phone dock (<module> list)" or "(<module> detail)" (30
characters at most). Paste the file's whole text, Save.

Canvas views (people who get one see no phone bar without these): look at
Setup > Customization > Canvas > List View. For each row on Leads,
Contacts, Accounts or Deals (e.g. "Leads - Tile View"), one more Client
Script: Name "Exotel dock (<module> <custom|tile|table>)", Category Module,
Page "List Page (Canvas)", the module, Canvas Type "Custom List View" /
"Tile View" / "Table View", the Canvas Zoho offers, Type "Page Event", Event
"onLoad", Next, paste the module's list file, Save. If Setup > Canvas >
Detail View lists Canvas detail pages: Page "Detail Page (Canvas)", Event
onLoad, the module's detail file.

## Step 9: incoming calls (Exotel website)

Exotel dashboard > App Bazaar > create a flow (or edit theirs):

1. (Optional) Greeting.
2. Passthru: URL = the `cti_webhook` URL + `&event=incoming`, Async ON.
3. Connect: "Configure parameters dynamically by providing a URL". Primary
   URL = the `cti_route` URL. Fallback URL = the `cti_route` URL +
   `&fallback=1`.
4. After Connect, when the call was answered: Passthru with the
   `cti_webhook` URL + `&event=connected`, then Hangup.
5. When nobody answered or nobody was dialled: Passthru with the
   `cti_webhook` URL + `&event=missed`, then Hangup (or voicemail).
6. Save, then Exotel dashboard > ExoPhones: assign this flow to the virtual
   number.

## Step 10: phone notifications

Zoho Setup > Experience Center > Signals: add a custom signal for incoming
calls (service Exotel, signal "Incoming call"). Get the namespace Zoho
shows, and the part of their CRM address that starts with `org` (e.g.
`org12345678`). Run
`npm run zoho:cti-setup -- --signal <namespace> --org <org...>`.

## Step 11: turn people on (Zoho website, CTI Admin tab)

1. Everyone in Zoho is listed with Calling off.
2. Switch Calling on for a person, then enter their mobile number when
   asked. Their SIP line is created at once ("SIP line created").
   - If their email already belongs to someone in the Exotel account (often
     the account's own admin, who stays on PSTN), that user is left as it
     is and the line is made as name+sip@ the same domain. The row says so.
   - If their number is already on another Exotel user, the line is made
     with SIP only (Exotel allows one user per number); Zoho still rings
     that number for them. The row says so.
   - If Exotel refuses, the row shows "Exotel replied: ..." with Exotel's
     exact words. Read them to the person as they are. Don't guess a cause.
3. Incoming calls tab: "A caller who isn't in Zoho" becomes a new lead (the
   default) or stays a number.
4. Each person, in their phone panel: Desktop or Phone at the top (the
   device they work on: Desktop takes calls in and out on SIP; Phone sends
   calls out on SIP and rings their number for calls in). The gear opens
   Settings, where outgoing calls can use their Number instead of SIP.
5. The first time, Chrome asks to use the microphone: "Allow while visiting
   the site".
6. Ask the person to reload a Leads page: the phone bar appears at the
   bottom right. If not: Calling on and number saved (CTI Admin), the Client
   Scripts (Step 8, Canvas too if their address contains `/canvas/`), and
   cti_crm Connected (Step 4).

## Step 12: test

1. Open a lead, click Call: Agent connecting, Agent connected, Connecting
   customer, Customer connected, then the disposition.
2. Call the virtual number from another phone: the phone bar opens with the
   caller. From a number not in Zoho: a new lead is made for the person
   rung, and their phone gets "<number> is calling".
3. In Calls, the call is logged with its disposition, and answered calls
   have the recording attached.

Tell them when everything is done, and list anything skipped.
