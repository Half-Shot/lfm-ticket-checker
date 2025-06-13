import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";

/**
 * The app state.
 */
interface State {
  soldOut: boolean;
  meetDate: Date;
  releaseDate: Date;
  lastCheck: number;
  announcements: Partial<{
    nextDateAnnouncement: boolean;
    ticketsOnSale: boolean;
    soldOutAnnouncement: boolean;
  }>
}

// These two need resetting for the next event. When that happens we can fetch these programatically next time.
const LFM_ROOT_EVENT_ID = '1684158';
const LFM_EVENT_ID = '6063433';
const DISCORD_MENTION_ROLE = '1383110606353338459';
const DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/1383108216186994698/d3kJXBa3aCe7MHMnCY0VleTdNCXGWgLfxUodcNYZqnR4FYN-3XyjYrMVStfVozvn48CV?wait=true';
const CHECK_INTERVAL_MS = 60 * 60 * 1000;

// Reader, I fought this website for a long time, pleading for it to work with fetch, or axios but for whatever reason
// it would hit the captcha check. Because life is short, this uses curlie.
// I also don't know what chk/1041 is..
// Extra: For some reason curlie (https://github.com/rs/curlie) works but curl does not.
const cmd = `curlie 'https://www.tickettailor.com/checkout/view-event/id/${LFM_EVENT_ID}/chk/1041/?modal_widget=true^&widget=true'
  --compressed
  -H 'User-Agent: Mozilla/5.0 (X11; Linux x86_64; rv:139.0) Gecko/20100101 Firefox/139.0'
  -H 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
  -H 'Accept-Language: en-US,en;q=0.5'
  -H 'Accept-Encoding: gzip, deflate, br, zstd'
  -H 'Referer: https://www.tickettailor.com/events/londonfurs/${LFM_ROOT_EVENT_ID}/select-date?modal_widget=true^&widget=true'
  -H 'DNT: 1'
  -H 'Sec-GPC: 1'
  -H 'Connection: keep-alive'
  -H 'Cookie: ${process.env.LFM_COOKIE_STRING}'
  -H 'Upgrade-Insecure-Requests: 1'
  -H 'Sec-Fetch-Dest: document'
  -H 'Sec-Fetch-Mode: navigate'
  -H 'Sec-Fetch-Site: same-origin'
  -H 'Sec-Fetch-User: ?1'
  -H 'Priority: u=0, i'
  -H 'Pragma: no-cache'
  -H 'Cache-Control: no-cache'
  -H 'TE: trailers'
`.replaceAll('\n', ' ');

const SaleDateRegex = /var onSaleDateMilliseconds =.*Date.now\(\).*\((\d+)\*1000\)/;
const TicketDateRegex = /<div class="date_and_time highlight-color-foreground"><span isolate>(\w+)<\/span> <var>(\d+)<\/var> <span isolate>(\w+)<\/span> <var>(\d+)<\/var>/;

async function writeState(state: State) {
    await writeFile('./state.json', JSON.stringify(state));
}


async function loadState(): Promise<State> {
    const state = JSON.parse(await readFile('./state.json', 'utf-8')) as State;
    return {
      ...state,
      meetDate: state.meetDate && new Date(state.meetDate),
      releaseDate: state.releaseDate && new Date(state.releaseDate),
    }
}


async function fetchEventState(exisingState: State): Promise<State> {
  // We use bash, for much the same reasons that I can be lazy about parsing out the details.
  const res = spawnSync('/usr/bin/bash', ['-c', cmd]);
  const html = res.stdout.toString();
  try {
    const meetDateRes = TicketDateRegex.exec(html);
    if (!meetDateRes?.[1]) {
        throw Error(`No value for meet date!`);
    }
    const matchRes = SaleDateRegex.exec(html);
    if (!matchRes?.[1]) {
        throw Error(`No value for release date!`);
    }
    const secondsUntilRelease = parseInt(matchRes[1]);
    if (isNaN(secondsUntilRelease)) {
      throw Error(`Unexpected value for release seconds: ${matchRes[1]}`);
    }
    const state: State = {
      releaseDate: new Date(Date.now() + secondsUntilRelease*1000),
      meetDate: new Date(`${meetDateRes[1]} ${meetDateRes[2]} ${meetDateRes[3]} ${meetDateRes[4]} 12:00`),
      soldOut: false, // This is NOT implemented as I have no idea what sold out looks like.
      announcements: exisingState.announcements,
      lastCheck: Date.now(),
    };
    if (!exisingState.releaseDate || state.releaseDate.getDate() !== exisingState.releaseDate.getDate()) {
      // New event, reset announcements
      state.announcements = {};
    }
    return state;
  } catch (ex) {
    console.error('Failure parsing out data from URL', ex);
    console.error('HTML:', html);
    process.exit(1);
  }
}

async function announceToDiscord(state: State) {
  const options: Intl.DateTimeFormatOptions = {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: 'GMT'
  };
  let content;
  if (!state.announcements.nextDateAnnouncement) {
    content = `<@&${DISCORD_MENTION_ROLE}> The next LondonFurs tickets for **${state.meetDate.toLocaleDateString("en-GB", options)}** are going on sale at **${state.releaseDate.toLocaleTimeString("en-GB", options)}**`;
  } else if (!state.announcements.ticketsOnSale) {
    content = `<@&${DISCORD_MENTION_ROLE}> **TICKETS ARE NOW ON SALE!!! GO GO GO GO GO**`;
  } else {
    content = `<@&${DISCORD_MENTION_ROLE}> Tickets have sold out 😞`;
  }
  const req = await fetch(DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      content,
      allowed_mentions: {
        roles: [DISCORD_MENTION_ROLE],
      },
      embeds: [{
        title: 'LondonFurs Meet – Tank & Paddle, Minister Court',
        type: 'rich',
        url: `https://www.tickettailor.com/events/londonfurs/${LFM_ROOT_EVENT_ID}`
      }]
    }),
  });
  // Does discord emit anything other than 200? Who knows.
  if (req.status > 299) {
    throw Error(`Discord encountered an error: ${req.status} ${await req.text()}`);
  }
}

async function main() {
  let state = await loadState();

  // We haven't got any data OR the data is stale.
  if (!state.releaseDate || (Date.now() - state.lastCheck > CHECK_INTERVAL_MS)) {
    state = await fetchEventState(state);
    await writeState(state);
  }

  if (!state.announcements?.nextDateAnnouncement) {
    // Announce if we haven't yet.
    await announceToDiscord(state);
    state.announcements.nextDateAnnouncement = true;
    await writeState(state);
  } else if (!state.announcements.ticketsOnSale && Date.now() > state.releaseDate.getTime()) {
    // If the release date has passed then announce it.
    // Always check to see if it's sold out once we're in "sale mode"
    state = await fetchEventState(state);
    if (!state.announcements.soldOutAnnouncement && state.soldOut) {
      await announceToDiscord(state);
      state.announcements.soldOutAnnouncement = true;
      await writeState(state);
    } else {
      await announceToDiscord(state);
      state.announcements.ticketsOnSale = true;
      await writeState(state);
    }
  } else {
    console.log('Nothing to do!');
  }
}

main().catch((ex) => {
  console.error('Encountered a fatal error', ex);
});