// IANA zone names across the database's renames. The database retired some
// spellings ("Europe/Kiev" became "Europe/Kyiv"), but engines disagree on
// which they use: V8 still reports the retired one, and an engine with an
// older zone database knows only that one and rejects the current name.
// Profiles show the current name; every Intl call gets the name the engine
// accepts. The server applies the same map (canonicalTimeZones in
// internal/service/user.go) to what it stores.

const renamedTimeZones: Record<string, string> = {
  'Europe/Kiev': 'Europe/Kyiv',
  'Europe/Uzhgorod': 'Europe/Kyiv',
  'Europe/Zaporozhye': 'Europe/Kyiv',
  'Asia/Calcutta': 'Asia/Kolkata',
  'Asia/Saigon': 'Asia/Ho_Chi_Minh',
  'Asia/Katmandu': 'Asia/Kathmandu',
  'Asia/Rangoon': 'Asia/Yangon',
  'Asia/Dacca': 'Asia/Dhaka',
  'Asia/Thimbu': 'Asia/Thimphu',
  'Asia/Ulan_Bator': 'Asia/Ulaanbaatar',
  'Atlantic/Faeroe': 'Atlantic/Faroe',
  'America/Godthab': 'America/Nuuk',
  'Pacific/Enderbury': 'Pacific/Kanton',
};

// The retired spelling an older engine knows a current zone by (the first
// one listed: "Europe/Kyiv" → "Europe/Kiev").
const retiredTimeZones: Record<string, string> = {};
for (const [retired, current] of Object.entries(renamedTimeZones)) {
  retiredTimeZones[current] ??= retired;
}

const accepted = new Map<string, boolean>();

// engineAccepts reports whether this engine's Intl knows the zone.
export function engineAccepts(timeZone: string): boolean {
  let ok = accepted.get(timeZone);
  if (ok === undefined) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date(0));
      ok = true;
    } catch {
      ok = false;
    }
    accepted.set(timeZone, ok);
  }
  return ok;
}

// canonicalTimeZone is a zone's current IANA name ("Europe/Kiev" →
// "Europe/Kyiv"), for display; any other value comes back unchanged.
export function canonicalTimeZone(timeZone: string): string {
  return renamedTimeZones[timeZone] ?? timeZone;
}

// currentTimeZoneName is the current name when this engine accepts it, and
// the name as given otherwise: what the browser reports and offers, so the
// value it sends is one it can format itself.
export function currentTimeZoneName(timeZone: string): string {
  const current = canonicalTimeZone(timeZone);
  return current !== timeZone && engineAccepts(current) ? current : timeZone;
}

// engineTimeZone is the name to hand Intl for a stored zone: as stored when
// the engine knows it, else the retired spelling it does know ("Europe/Kyiv"
// on an engine that only knows "Europe/Kiev"). '' stays '' (the runtime's
// own zone).
export function engineTimeZone(timeZone: string): string {
  if (!timeZone || engineAccepts(timeZone)) return timeZone;
  const retired = retiredTimeZones[timeZone];
  return retired && engineAccepts(retired) ? retired : timeZone;
}
