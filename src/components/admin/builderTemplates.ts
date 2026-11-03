// Starting points for the webhooks panel's builder: each shows off what
// cards and forms can do, and each passes the server's checks as it is.

const txt = (text: string) => ({ type: 'plain_text', text });
const md = (text: string) => ({ type: 'markdown', text });
const opt = (value: string, text: string, description?: string) => ({ value, text: txt(text), ...(description && { description: txt(description) }) });

export interface BuilderTemplate {
  key: string;
  label: string;
  payload: object;
}

export const MESSAGE_TEMPLATES: BuilderTemplate[] = [
  {
    key: 'deploy',
    label: 'Deploy',
    payload: {
      text: 'Deploy of api 1.42 finished',
      blocks: [
        { type: 'header', text: txt('Deploy finished') },
        {
          type: 'section',
          text: md('**api 1.42** is live on production.'),
          accessory: { type: 'button', text: txt('Open release notes'), url: 'https://example.com/releases/1.42' },
        },
        {
          type: 'actions',
          elements: [
            { type: 'button', style: 'primary', ex_action: 'ack', text: txt('Acknowledge') },
            { type: 'button', ex_action: 'vote', text: txt('Looks good') },
          ],
        },
        { type: 'context', elements: [md('Finished <!date^1761058323^{time}|14:52 UTC> by the release bot')] },
      ],
    },
  },
  {
    key: 'approval',
    label: 'Approval',
    payload: {
      text: 'Bob submitted an expense: Team dinner, €184.50',
      blocks: [
        {
          type: 'section',
          text: md('**Bob** submitted an expense for approval.'),
          accessory: { type: 'image', image_url: 'https://picsum.photos/seed/receipt/200/200', alt_text: 'Receipt photo' },
        },
        { type: 'section', fields: [md('**Amount**\n€184.50'), md('**For**\nTeam dinner'), md('**Date**\nOct 29'), md('**Approver**\nAlice')] },
        {
          type: 'actions',
          elements: [
            { type: 'button', action_id: 'approve', style: 'primary', text: txt('Approve') },
            {
              type: 'button',
              action_id: 'reject',
              style: 'danger',
              text: txt('Reject'),
              confirm: { title: txt('Reject this expense?'), text: txt('Bob will be asked for more detail.'), confirm: txt('Reject'), deny: txt('Keep it') },
            },
            {
              type: 'overflow',
              action_id: 'more',
              options: [{ ...opt('receipt', 'View the receipt'), url: 'https://example.com/receipts/42' }, opt('ask', 'Ask Bob a question'), opt('later', 'Remind me later')],
            },
          ],
        },
      ],
    },
  },
  {
    key: 'triage',
    label: 'Triage',
    payload: {
      text: 'New bug: checkout returns 500',
      blocks: [
        { type: 'header', text: txt('🐞 Checkout returns 500') },
        { type: 'section', text: md('Reported by @carol@example.com from the support queue — <@bob@example.com> is on call. Happens on the second payment attempt.') },
        {
          type: 'actions',
          block_id: 'triage',
          elements: [
            { type: 'users_select', action_id: 'assignee', placeholder: txt('Assign to…') },
            {
              type: 'static_select',
              action_id: 'priority',
              placeholder: txt('Priority'),
              options: [opt('p1', 'P1 · drop everything'), opt('p2', 'P2 · this week'), opt('p3', 'P3 · this month'), opt('p4', 'P4 · someday')],
            },
            { type: 'datepicker', action_id: 'due', placeholder: txt('Due date') },
          ],
        },
        { type: 'context', elements: [{ type: 'image', image_url: 'https://picsum.photos/seed/support/64/64', alt_text: 'Support' }, md('From the support queue · #4821')] },
      ],
    },
  },
  {
    key: 'checklist',
    label: 'Checklist',
    payload: {
      text: 'Release checklist for 2.14',
      blocks: [
        { type: 'section', text: md('**Release checklist** · web 2.14') },
        {
          type: 'actions',
          elements: [
            {
              type: 'checkboxes',
              action_id: 'steps',
              options: [
                opt('tests', 'Tests green on main'),
                opt('notes', 'Release notes written', 'Link them in the thread'),
                opt('qa', 'QA sign-off'),
                opt('comms', 'Support told'),
              ],
              initial_options: [opt('tests', 'Tests green on main')],
            },
          ],
        },
      ],
    },
  },
  {
    key: 'poll',
    label: 'Poll',
    payload: {
      text: 'Team lunch on Friday — where should we go?',
      blocks: [
        { type: 'section', text: md('**Team lunch on Friday** — where should we go?') },
        {
          type: 'actions',
          elements: ['Thai Garden', 'Pizza Place', 'Sushi Corner', 'Order in'].map((name, i) => ({ type: 'button', action_id: `opt${i}`, ex_action: 'vote', text: txt(name) })),
        },
      ],
    },
  },
  {
    key: 'photo',
    label: 'Photo',
    payload: {
      text: 'New office photos',
      blocks: [
        { type: 'image', image_url: 'https://picsum.photos/seed/office/800/450', alt_text: 'The new kitchen', text: txt('The new kitchen is open') },
        { type: 'context', elements: [{ type: 'image', image_url: 'https://picsum.photos/seed/alice/64/64', alt_text: 'Alice' }, md('Shared by **Alice** · Facilities')] },
      ],
    },
  },
  {
    key: 'notes',
    label: 'Release notes',
    payload: {
      text: 'Release 1.43 is live',
      blocks: [
        {
          type: 'rich_text',
          content: [
            { type: 'heading', level: 2, spans: [{ text: 'Release 1.43' }, { text: ' ' }, { type: 'pill', text: 'Live', color: 'green' }] },
            {
              type: 'paragraph',
              spans: [
                { text: 'Checkout is ' },
                { text: '20% faster', bold: true, color: 'green' },
                { text: ', and order history loads in one go. Thanks ' },
                { type: 'user', user: 'alice@example.com' },
                { text: '!' },
              ],
            },
            {
              type: 'list',
              style: 'bullet',
              items: [
                { spans: [{ text: 'New: ', bold: true }, { text: 'saved carts sync across devices' }] },
                { spans: [{ text: 'Fixed: ', bold: true }, { text: 'totals rounding on refunds' }] },
                { spans: [{ text: 'Removed: ', bold: true }, { text: 'the old checkout', strike: true }] },
              ],
            },
            { type: 'quote', spans: [{ text: 'Rollback: run ' }, { text: 'make rollback V=1.42', code: true }] },
            { type: 'code', language: 'bash', text: 'curl -s https://status.example.com/api | jq .checkout' },
          ],
        },
      ],
    },
  },
  {
    key: 'status',
    label: 'Incident status',
    payload: {
      text: 'Checkout errors: mitigated',
      blocks: [
        { type: 'header', text: txt('Checkout errors · INC-2291') },
        {
          type: 'callout',
          icon: 'warning',
          color: 'orange',
          content: [{ type: 'paragraph', spans: [{ text: 'Mitigated', bold: true }, { text: '. Error rate is back under 1%; we are watching it for an hour.' }] }],
        },
        {
          type: 'table',
          columns: [{ header: 'Service' }, { header: 'Status', align: 'center' }, { header: 'Error rate', align: 'right' }],
          rows: [
            [{ text: 'checkout-api' }, { spans: [{ type: 'pill', text: 'Recovering', color: 'orange' }] }, { text: '0.8%' }],
            [{ text: 'payments' }, { spans: [{ type: 'pill', text: 'Healthy', color: 'green' }] }, { text: '0.1%' }],
            [{ text: 'web' }, { spans: [{ type: 'pill', text: 'Healthy', color: 'green' }] }, { text: '0.2%' }],
          ],
        },
        {
          type: 'toggle',
          summary: [{ text: 'Timeline', bold: true }, { text: ' · 4 updates' }],
          blocks: [
            {
              type: 'rich_text',
              content: [
                {
                  type: 'list',
                  items: [
                    { spans: [{ text: '09:41 ', code: true }, { text: 'Alert: checkout 5xx above 5%' }] },
                    { spans: [{ text: '09:48 ', code: true }, { text: 'Rolled back web v2.15.1' }] },
                    { spans: [{ text: '10:02 ', code: true }, { text: 'Error rate under 1%' }] },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  },
  {
    key: 'dashboard',
    label: 'Dashboard',
    payload: {
      text: 'Weekly metrics: 1,284 signups, €84.2k revenue',
      blocks: [
        { type: 'header', text: txt('Weekly metrics · week 44') },
        {
          type: 'columns',
          blocks: [
            {
              type: 'column',
              blocks: [
                {
                  type: 'callout',
                  content: [
                    { type: 'paragraph', spans: [{ text: 'Signups', color: 'gray' }] },
                    { type: 'heading', level: 1, spans: [{ text: '1,284' }] },
                    { type: 'paragraph', spans: [{ type: 'pill', text: '↑ 12%', color: 'green' }] },
                  ],
                },
              ],
            },
            {
              type: 'column',
              blocks: [
                {
                  type: 'callout',
                  content: [
                    { type: 'paragraph', spans: [{ text: 'Revenue', color: 'gray' }] },
                    { type: 'heading', level: 1, spans: [{ text: '€84.2k' }] },
                    { type: 'paragraph', spans: [{ type: 'pill', text: '↑ 6%', color: 'green' }] },
                  ],
                },
              ],
            },
          ],
        },
        {
          type: 'chart',
          kind: 'bar',
          text: txt('Signups by day'),
          labels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
          series: [
            { name: 'Web', values: [180, 210, 195, 240, 230] },
            { name: 'Mobile', values: [60, 72, 70, 88, 81] },
          ],
        },
      ],
    },
  },
];

export const FORM_TEMPLATES: BuilderTemplate[] = [
  {
    key: 'feedback',
    label: 'Feedback',
    payload: {
      type: 'modal',
      callback_id: 'feedback',
      title: txt('Share feedback'),
      submit: txt('Send'),
      blocks: [
        { type: 'section', text: md('How did the **offsite** go? Answers are anonymous.') },
        {
          type: 'input',
          block_id: 'rating',
          label: txt('Overall'),
          element: { type: 'radio_buttons', options: [opt('great', 'Great', 'Would do it again'), opt('ok', 'Fine'), opt('meh', 'Not for me')] },
        },
        {
          type: 'input',
          block_id: 'liked',
          label: txt('What worked?'),
          optional: true,
          element: { type: 'checkboxes', options: [opt('talks', 'Talks'), opt('food', 'Food'), opt('venue', 'Venue'), opt('activities', 'Activities')] },
        },
        { type: 'input', block_id: 'comments', label: txt('Anything else?'), optional: true, element: { type: 'plain_text_input', multiline: true, max_length: 500 } },
      ],
    },
  },
  {
    key: 'booking',
    label: 'Booking',
    payload: {
      type: 'modal',
      callback_id: 'booking',
      title: txt('Book a room'),
      submit: txt('Book'),
      blocks: [
        { type: 'input', block_id: 'day', label: txt('Day'), element: { type: 'datepicker' } },
        { type: 'input', block_id: 'start', label: txt('Start'), element: { type: 'timepicker', initial_time: '10:00' } },
        {
          type: 'input',
          block_id: 'people',
          label: txt('How many people'),
          hint: txt('Rooms seat 2 to 12.'),
          element: { type: 'number_input', is_decimal_allowed: false, min_value: '1', max_value: '12', initial_value: '4' },
        },
        { type: 'input', block_id: 'invite', label: txt('Invite'), optional: true, element: { type: 'multi_users_select', max_selected_items: 10, placeholder: txt('Search people') } },
      ],
    },
  },
  {
    key: 'bug',
    label: 'Bug report',
    payload: {
      type: 'modal',
      callback_id: 'bug',
      title: txt('Report a bug'),
      submit: txt('Report'),
      blocks: [
        { type: 'input', block_id: 'title', label: txt('What broke?'), element: { type: 'plain_text_input', max_length: 80, placeholder: txt('Checkout returns 500') } },
        {
          type: 'input',
          block_id: 'severity',
          label: txt('Severity'),
          element: { type: 'static_select', options: [opt('sev1', 'SEV1 · everyone'), opt('sev2', 'SEV2 · many'), opt('sev3', 'SEV3 · some')], initial_option: opt('sev3', 'SEV3 · some') },
        },
        {
          type: 'input',
          block_id: 'platforms',
          label: txt('Where'),
          element: { type: 'multi_static_select', options: [opt('web', 'Web'), opt('ios', 'iOS'), opt('android', 'Android'), opt('desktop', 'Desktop')] },
        },
        { type: 'input', block_id: 'steps', label: txt('Steps to reproduce'), element: { type: 'plain_text_input', multiline: true, min_length: 20 } },
        { type: 'input', block_id: 'link', label: txt('Link'), optional: true, element: { type: 'url_text_input', placeholder: txt('https://…') } },
        { type: 'input', block_id: 'contact', label: txt('Who to ask'), optional: true, element: { type: 'email_text_input' } },
      ],
    },
  },
];

export const pretty = (payload: object) => JSON.stringify(payload, null, 2);
