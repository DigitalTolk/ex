import { useMemo, useState } from 'react';
import { Clock, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  useCreateAgentSubscription,
  useSkills,
  useUpdateAgentSchedule,
  type AgentSubscription,
  type AgentView,
} from '@/hooks/useAgents';
import { useConnectors } from '@/hooks/useConnectors';
import { useCreateChannel, useUserChannels } from '@/hooks/useChannels';
import { useCreateConversation, useSearchUsers } from '@/hooks/useConversations';
import { useAuth } from '@/context/AuthContext';
import { ApiError } from '@/lib/api';
import { slugify } from '@/lib/format';
import {
  cronFromParts,
  localTimeZone,
  partsFromCron,
  suggestChannelName,
  timeZoneOptions,
  WEEKDAY_NAMES,
  type Cadence,
} from '@/lib/schedule';
import { showToast } from '@/lib/toast';

// The destination is ONE control with three kinds of answer: a new channel
// (the default — a recurring report deserves its own home), a DM, or an
// existing channel. Anything else is that channel's id.
const NEW_CHANNEL = 'new';
const DM = 'dm';
// "user:<id>" delivers to a group DM with that person (and the agent), so a
// standing order can report to a teammate, not only to its creator.
const USER_PREFIX = 'user:';

// Inline controls share one look so the sentence reads as a sentence rather
// than a row of mismatched widgets.
const inline =
  'h-7 rounded-md border border-border/60 bg-background px-1.5 text-sm ' +
  'focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none';

// ScheduleForm composes a standing order as ONE EDITABLE SENTENCE —
// "Every weekday at 08:00 · @gg posts to a new channel named daily-revenue".
// Earlier passes labelled every field (When / Result / Tools) and boxed each
// choice; correct, but it read as a settings panel for something that is
// really one instruction. The sentence carries its own labels, so the chrome
// disappears. Used on an agent's card (agent fixed) and on the Schedules page
// (agent picked), so the two surfaces can never drift in what they send.
// With `editing` it opens pre-filled and saves in place; the destination is
// shown but fixed (it is part of the order's identity server-side).
export function ScheduleForm({
  agents,
  fixedAgent,
  editing,
  editingDestination,
  onDone,
}: {
  agents?: AgentView[];
  fixedAgent?: AgentView;
  editing?: AgentSubscription;
  editingDestination?: string;
  onDone: () => void;
}) {
  const { data: channels } = useUserChannels();
  const createConversation = useCreateConversation();
  const { user: me } = useAuth();
  const { data: connectors } = useConnectors();
  const { data: skills } = useSkills();
  const createChannel = useCreateChannel();

  const [slug, setSlug] = useState(fixedAgent?.slug ?? '');
  const [destination, setDestination] = useState(NEW_CHANNEL);
  // The picker searches, so the chosen label is kept alongside the value —
  // a person picked from a search result is not in any list we still hold.
  const [destinationLabel, setDestinationLabel] = useState('a new channel');
  const [newChannelName, setNewChannelName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const initial = editing ? partsFromCron(editing.schedule) : null;
  const [cadence, setCadence] = useState<Cadence>(initial?.cadence ?? 'weekdays');
  const [weekday, setWeekday] = useState(initial?.weekday ?? 1);
  const [time, setTime] = useState(initial?.time ?? '08:00');
  const [instruction, setInstruction] = useState(editing?.instruction ?? '');
  const [pickedConnectors, setPickedConnectors] = useState<string[]>(editing?.connectorSlugs ?? []);
  const [pickedSkills, setPickedSkills] = useState<string[]>(editing?.skillIDs ?? []);
  const [toolsOpen, setToolsOpen] = useState(false);
  // The slug of a new-channel name found to be taken, so the warning clears
  // itself as soon as the name is edited.
  const [takenSlug, setTakenSlug] = useState('');

  const create = useCreateAgentSubscription(slug);
  const update = useUpdateAgentSchedule(slug);
  // Defaults to the viewer's zone (or the edited order's), but an order can be
  // pinned to another — "08:00 Stockholm" for a team that isn't where its
  // creator is. An empty zone lets the server use the creator's profile zone.
  const browserTZ = useMemo(() => localTimeZone(), []);
  const startTZ = editing ? (editing.scheduleTZ ?? '') : browserTZ;
  const zones = useMemo(() => timeZoneOptions(startTZ, browserTZ), [startTZ, browserTZ]);
  const [tz, setTz] = useState(startTZ);
  const chosen = fixedAgent ?? agents?.find((a) => a.slug === slug);
  // Scheduled work fires whether or not anyone is at their desk, so a CLI
  // agent — which runs on the creator's own machine — can only keep the
  // appointment when the desktop app happens to be open at that hour.
  const isCLI = !!chosen && chosen.resolved.harness !== 'bedrock';
  const agentID = chosen?.id ?? '';
  const myChannels = channels ?? [];
  const mySkills = skills ?? [];
  const installed = (connectors ?? []).filter((c) => c.installed);
  const pinnedCount = pickedConnectors.length + pickedSkills.length;
  const hasTools = installed.length > 0 || mySkills.length > 0;

  // The channel name writes itself from the instruction until the user edits
  // it, so the common path stays: type what you want, press Schedule.
  const channelName = nameTouched ? newChannelName : suggestChannelName(instruction);
  const makingChannel = !editing && destination === NEW_CHANNEL;
  // Names collide by slug server-side ("Daily Revenue" = "daily-revenue").
  const nameTaken = makingChannel && !!takenSlug && takenSlug === slugify(channelName);
  // A clash with a channel you're in can offer that channel instead; one you
  // can't see (someone else's private channel) can only ask for a new name.
  const existing = nameTaken ? myChannels.find((c) => slugify(c.channelName) === takenSlug) : undefined;

  const ready = !!slug && !!instruction.trim() && (!makingChannel || !!channelName.trim());
  const pending =
    create.isPending || update.isPending || createChannel.isPending || createConversation.isPending;
  const toUser = destination.startsWith(USER_PREFIX) ? destination.slice(USER_PREFIX.length) : '';

  const toggle = (list: string[], set: (v: string[]) => void, value: string) =>
    set(list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);

  // No parentID = the server files the order in your own DM with the agent.
  // A channel destination posts there instead, so the action mode follows the
  // destination: notify keeps the result private, autonomous lets it post.
  const schedule = (parentID: string, parentType: 'channel' | 'conversation' = 'channel') =>
    create.mutate(
      {
        ...(parentID ? { parentID, parentType } : {}),
        instruction: instruction.trim(),
        schedule: cronFromParts(cadence, time, weekday),
        scheduleTZ: tz,
        actionMode: parentID ? 'autonomous' : 'notify',
        connectorSlugs: pickedConnectors,
        skillIDs: pickedSkills,
      },
      {
        onSuccess: onDone,
        onError: () => showToast("Couldn't save that scheduled order — try again."),
      },
    );

  const submit = () => {
    if (!ready) return;
    if (editing) {
      update.mutate(
        {
          parentID: editing.parentID,
          id: editing.id,
          instruction: instruction.trim(),
          schedule: cronFromParts(cadence, time, weekday),
          scheduleTZ: tz,
          connectorSlugs: pickedConnectors,
          skillIDs: pickedSkills,
        },
        {
          onSuccess: onDone,
          onError: () => showToast("Couldn't save your changes — try again."),
        },
      );
      return;
    }
    if (makingChannel) {
      const wanted = slugify(channelName);
      if (myChannels.some((c) => slugify(c.channelName) === wanted)) {
        setTakenSlug(wanted);
        return;
      }
      createChannel.mutate(
        { name: channelName.trim(), type: 'private' },
        {
          onSuccess: (ch) => schedule(ch.id),
          onError: (err) => {
            if (err instanceof ApiError && err.status === 409) setTakenSlug(wanted);
            else showToast("Couldn't create that channel — try again.");
          },
        },
      );
      return;
    }
    if (toUser) {
      // A group DM with the recipient AND the agent — the agent has to be a
      // participant to post there, and the creator is added automatically.
      createConversation.mutate(
        { type: 'group', participantIDs: [toUser, agentID] },
        {
          onSuccess: (conv) => schedule(conv.id, 'conversation'),
          onError: () => showToast("Couldn't open that conversation — try again."),
        },
      );
      return;
    }
    schedule(destination === DM ? '' : destination);
  };

  const id = (part: string) => `sched-${part}-${editing?.id ?? fixedAgent?.slug ?? 'any'}`;

  return (
    <div className="rounded-xl border border-border/60 bg-card p-4" data-testid="schedule-form">
      {/* Line 1 — WHEN, as prose. */}
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-2 text-sm">
        <Clock className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
        <span className="text-muted-foreground">Every</span>
        <select
          id={id('cadence')}
          aria-label="Repeats"
          className={inline}
          value={cadence}
          onChange={(e) => setCadence(e.target.value as Cadence)}
        >
          <option value="weekdays">weekday</option>
          <option value="daily">day</option>
          <option value="weekly">week on</option>
        </select>
        {cadence === 'weekly' && (
          <select
            id={id('weekday')}
            aria-label="On"
            className={inline}
            value={weekday}
            onChange={(e) => setWeekday(Number(e.target.value))}
          >
            {WEEKDAY_NAMES.map((name, i) => (
              <option key={name} value={i}>
                {name}
              </option>
            ))}
          </select>
        )}
        <span className="text-muted-foreground">at</span>
        <Input
          id={id('time')}
          aria-label="At"
          type="time"
          className="h-7 w-[104px] px-1.5 text-sm"
          value={time}
          onChange={(e) => setTime(e.target.value)}
        />
        <select
          id={id('tz')}
          aria-label="Timezone"
          className={inline + ' max-w-48'}
          value={tz}
          onChange={(e) => setTz(e.target.value)}
        >
          {!zones.includes(startTZ) && <option value="">my profile timezone</option>}
          {zones.map((z) => (
            <option key={z} value={z}>
              {z.replaceAll('_', ' ')}
            </option>
          ))}
        </select>
      </div>

      {/* The instruction is the substance — it gets the room. */}
      <textarea
        id={id('instruction')}
        aria-label="What should it do?"
        className="mt-3 min-h-20 w-full rounded-lg border border-border/60 bg-background p-3 text-sm focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
        placeholder="Pull yesterday's revenue dashboard from metabase and summarise the three biggest moves."
        maxLength={4000}
        value={instruction}
        onChange={(e) => setInstruction(e.target.value)}
      />

      {/* Line 2 — WHO, WHERE and WITH WHAT, as prose. */}
      <div className="mt-3 flex flex-wrap items-center gap-x-1.5 gap-y-2 text-sm">
        {fixedAgent ? (
          <span className="font-medium">@{fixedAgent.displayName}</span>
        ) : (
          <select
            id={id('agent')}
            aria-label="Agent"
            className={inline}
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
          >
            <option value="">pick an agent…</option>
            {agents?.map((a) => (
              <option key={a.slug} value={a.slug}>
                @{a.displayName}
              </option>
            ))}
          </select>
        )}
        <span className="text-muted-foreground">posts to</span>
        {editing ? (
          <span className="font-medium" data-testid="schedule-form-destination">
            {editingDestination}
          </span>
        ) : (
          <DestinationPicker
            label={destinationLabel}
            channels={myChannels}
            excludeUserID={me?.id}
            onChange={(v, label) => {
              setDestination(v);
              setDestinationLabel(label);
            }}
          />
        )}
        {makingChannel && (
          <>
            <span className="text-muted-foreground">named</span>
            <Input
              id={id('channel-name')}
              aria-label="Channel name"
              aria-invalid={nameTaken}
              className="h-7 w-40 px-1.5 text-sm"
              placeholder="daily-revenue"
              maxLength={64}
              value={channelName}
              onChange={(e) => {
                setNameTouched(true);
                setNewChannelName(e.target.value);
              }}
            />
          </>
        )}
        {hasTools && (
          <>
            <span className="text-muted-foreground">using</span>
            <button
              type="button"
              aria-expanded={toolsOpen}
              className={
                inline +
                ' inline-flex items-center gap-1 ' +
                (pinnedCount > 0 ? 'text-foreground' : 'text-muted-foreground')
              }
              onClick={() => setToolsOpen((v) => !v)}
            >
              {pinnedCount === 0 ? '+ tools' : `${pinnedCount} pinned`}
            </button>
          </>
        )}
      </div>

      {nameTaken && (
        <p role="alert" className="mt-2 text-xs text-destructive" data-testid="schedule-channel-taken">
          A channel named “{channelName.trim()}” already exists — pick another name
          {existing && (
            <>
              {' or '}
              <button
                type="button"
                className="underline underline-offset-2"
                onClick={() => {
                  setDestination(existing.channelID);
                  setDestinationLabel(`~${existing.channelName}`);
                }}
              >
                post to ~{existing.channelName}
              </button>
            </>
          )}
          .
        </p>
      )}

      {/* Tools stay folded: a dozen chips is the noisiest thing on the form
          and most orders need none. */}
      {toolsOpen && hasTools && (
        <div className="mt-2 space-y-1.5 rounded-lg border border-border/60 bg-muted/30 p-2.5">
          {installed.length > 0 && (
            <div className="flex flex-wrap items-center gap-1" data-testid="schedule-connectors">
              {installed.map((c) => (
                <Chip
                  key={c.slug}
                  active={pickedConnectors.includes(c.slug)}
                  onClick={() => toggle(pickedConnectors, setPickedConnectors, c.slug)}
                  label={`/${c.slug}`}
                />
              ))}
            </div>
          )}
          {mySkills.length > 0 && (
            <div className="flex flex-wrap items-center gap-1" data-testid="schedule-skills">
              {mySkills.map((sk) => (
                <Chip
                  key={sk.id}
                  active={pickedSkills.includes(sk.id)}
                  onClick={() => toggle(pickedSkills, setPickedSkills, sk.id)}
                  label={sk.name}
                  icon={<Sparkles className="h-3 w-3" aria-hidden="true" />}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {isCLI && (
        <p className="mt-3 text-xs text-muted-foreground" data-testid="schedule-form-cli-warning">
          @{chosen?.displayName} runs on your computer, so this fires only while your ex desktop app
          is open. Pick a Bedrock agent for unattended work.
        </p>
      )}

      <div className="mt-4 flex items-center gap-2">
        <Button size="sm" onClick={submit} disabled={!ready || pending}>
          {pending ? 'Saving…' : editing ? 'Save changes' : 'Schedule it'}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function Chip({
  active,
  onClick,
  label,
  icon,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  icon?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors ' +
        (active
          ? 'border-primary/60 bg-primary/10 text-foreground'
          : 'border-border/60 text-muted-foreground hover:bg-muted')
      }
    >
      {icon}
      {label}
    </button>
  );
}

// DestinationPicker is a searchable combobox, not a <select>: on a real
// workspace the roster runs to hundreds of people and the channel list to
// dozens, and a flat dropdown of all of them is unusable. Channels come from
// the caller's OWN memberships (the /channels endpoint is membership-scoped),
// and people are fetched by server-side search as you type rather than by
// loading the whole roster up front.
function DestinationPicker({
  label,
  channels,
  excludeUserID,
  onChange,
}: {
  label: string;
  channels: { channelID: string; channelName: string }[];
  excludeUserID?: string;
  onChange: (value: string, label: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const { data: found, isFetching } = useSearchUsers(query);

  const q = query.trim().toLowerCase();
  const fixed = [
    { value: NEW_CHANNEL, label: 'a new channel' },
    { value: DM, label: 'a DM to me' },
  ].filter((o) => !q || o.label.toLowerCase().includes(q));
  const matchedChannels = channels
    .filter((c) => !q || c.channelName.toLowerCase().includes(q))
    .slice(0, 8);
  // Agent users carry no email by construction (they never authenticate —
  // see SeedDefaults), which is how they're told apart from people; a DM to
  // yourself is already the "a DM to me" option.
  const people = (found ?? []).filter((u) => !!u.email && u.id !== excludeUserID).slice(0, 8);

  const choose = (v: string, l: string) => {
    onChange(v, l);
    setQuery('');
    setOpen(false);
  };

  if (!open) {
    return (
      <button
        type="button"
        aria-label="Where the result goes"
        aria-expanded={false}
        className={inline}
        onClick={() => setOpen(true)}
      >
        {label} ▾
      </button>
    );
  }

  return (
    <span className="relative inline-flex">
      <Input
        autoFocus
        aria-label="Where the result goes"
        aria-expanded
        className="h-7 w-52 px-1.5 text-sm"
        placeholder="channel or person…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
        }}
      />
      {/* Clicking anywhere else closes without choosing. */}
      <button
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        className="fixed inset-0 z-10 cursor-default"
        onClick={() => setOpen(false)}
      />
      <div
        role="listbox"
        aria-label="Destinations"
        data-testid="destination-options"
        className="absolute top-8 left-0 z-20 max-h-64 w-64 overflow-auto rounded-lg border border-border/60 bg-popover p-1 shadow-md"
      >
        {fixed.map((o) => (
          <Option key={o.value} onClick={() => choose(o.value, o.label)}>
            {o.label}
          </Option>
        ))}
        {matchedChannels.length > 0 && <GroupLabel>Channels you're in</GroupLabel>}
        {matchedChannels.map((c) => (
          <Option key={c.channelID} onClick={() => choose(c.channelID, `~${c.channelName}`)}>
            ~{c.channelName}
          </Option>
        ))}
        <GroupLabel>People</GroupLabel>
        {q.length < 2 ? (
          <p className="px-2 py-1 text-xs text-muted-foreground">Type 2+ letters to find someone</p>
        ) : isFetching && people.length === 0 ? (
          <p className="px-2 py-1 text-xs text-muted-foreground">Searching…</p>
        ) : people.length === 0 ? (
          <p className="px-2 py-1 text-xs text-muted-foreground">No one matches “{query.trim()}”</p>
        ) : (
          people.map((u) => (
            <Option
              key={u.id}
              onClick={() => choose(`${USER_PREFIX}${u.id}`, `a DM to ${u.displayName}`)}
            >
              a DM to {u.displayName}
            </Option>
          ))
        )}
      </div>
    </span>
  );
}

function Option({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={false}
      className="block w-full truncate rounded px-2 py-1 text-left text-sm hover:bg-accent"
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-2 pt-1.5 pb-0.5 text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
      {children}
    </p>
  );
}
