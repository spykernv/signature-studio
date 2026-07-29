"use client";

import { useRef, useState } from "react";

/**
 * The instructions. This is where a first-timer succeeds or gives up, so the content matters
 * more than the component: exact menu labels, and the two beats that decide the outcome.
 *
 * GMAIL: Save Changes sits at the bottom of a long settings page, below the fold, and is
 * missed constantly — everything above it looks saved because Gmail's UI is autosaved
 * everywhere else in the product. And both "Signature defaults" dropdowns default to
 * "No signature", so a correctly pasted signature can still never appear on a single mail.
 *
 * OUTLOOK: the signature EDITOR renders the GIF frozen on its first frame. Told afterwards it
 * reads as an excuse; told beforehand it is a specification. It matters that they hear it
 * first, because they are looking at the editor at the exact moment they decide whether this
 * tool works.
 */

interface Step {
  do: string;
  why?: string;
}

interface Client {
  id: string;
  label: string;
  where: string;
  heads_up?: string;
  steps: Step[];
  animates: string;
}

const CLIENTS: Client[] = [
  {
    id: "gmail",
    label: "Gmail",
    where: "gmail.com in a browser, on a computer",
    steps: [
      { do: "Click the gear icon, top right, then See all settings." },
      { do: "Stay on the General tab and scroll down to Signature." },
      {
        do: "Click Create new, give it a name, click Create.",
        why: "Skip this if you already have a signature you want to replace — select it instead, then select everything in the box and delete it first.",
      },
      {
        do: "Click into the large signature box and paste with Ctrl+V, or ⌘V on a Mac.",
        why: "Use a plain paste. Ctrl+Shift+V pastes as plain text and strips the images.",
      },
      {
        do: "Under Signature defaults, set both dropdowns to your new signature — FOR NEW EMAILS USE and ON REPLY/FORWARD USE.",
        why: "Both default to No signature. Leave them and the signature is saved but never sent.",
      },
      {
        do: "Scroll to the very bottom of the page and click Save Changes.",
        why: "This is the step people miss. It is below the fold, past several more settings, and nothing on this page is saved until you click it. Navigating away first discards everything.",
      },
    ],
    animates: "Gmail animates the signature for you and for everyone who receives it.",
  },
  {
    id: "outlook",
    label: "Outlook",
    where: "Outlook on the web, new Outlook, or classic Outlook on Windows",
    heads_up:
      "Outlook's signature editor shows the animation frozen on its first frame. Every version does, and there is no setting for it. Nothing is broken — the editor simply does not play GIFs. It animates in the message your recipient opens.",
    steps: [
      {
        do: "Outlook on the web and new Outlook: Settings, the gear icon, then Mail, then Compose and reply.",
      },
      {
        do: "Classic Outlook on Windows: File, then Options, then Mail, then the Signatures button.",
      },
      { do: "Click New signature, or New, and give it a name." },
      { do: "Click into the editing box and paste with Ctrl+V." },
      {
        do: "Set both defaults — For new messages and For replies/forwards — to this signature.",
        why: "In classic Outlook these two dropdowns are on the right, under Choose default signature, and they also need the right account selected above them.",
      },
      { do: "Click Save, or OK in classic Outlook." },
    ],
    animates:
      "Classic Outlook on Microsoft 365 and Office 2021 animates GIFs in received mail, as do new Outlook and Outlook on the web. Outlook 2016, Outlook 2019 and Outlook for Mac show the first frame only — which is why the first frame of your signature is already the finished, resting image.",
  },
  {
    id: "apple",
    label: "Apple Mail",
    where: "the Mail app on macOS",
    steps: [
      { do: "Open Mail, then Settings from the Mail menu, or press ⌘ and comma." },
      { do: "Open the Signatures tab." },
      {
        do: "Select the account you send from in the left column, then click the + button.",
        why: "Create it under All Signatures and it belongs to no account; you then have to drag it onto the account before it can be used.",
      },
      {
        do: "Uncheck Always match my default message font, below the preview.",
        why: "Leave it checked and Mail rewrites the pasted signature into plain text, taking the images with it.",
      },
      { do: "Select everything in the right-hand preview pane, delete it, and paste with ⌘V." },
      {
        do: "Close Settings, then pick the signature from the Signature menu in a new message, or set Choose Signature for the account.",
      },
    ],
    animates: "Apple Mail animates the signature in sent and received mail.",
  },
];

export default function PasteSteps() {
  const [active, setActive] = useState(0);
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);

  const move = (to: number) => {
    const next = (to + CLIENTS.length) % CLIENTS.length;
    setActive(next);
    tabs.current[next]?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "ArrowRight") move(active + 1);
    else if (e.key === "ArrowLeft") move(active - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(CLIENTS.length - 1);
    else return;
    e.preventDefault();
  };

  const client = CLIENTS[active];

  return (
    <section>
      <p className="stamp">Paste it in</p>

      <p className="mt-3 max-w-prose text-sm leading-relaxed text-ink-2">
        Finish on a computer. The Gmail and Outlook signature editors on iOS and Android are
        plain-text fields — no tool can install a signature with images from a phone.
      </p>

      <div role="tablist" aria-label="Mail client" className="mt-8 flex border-b border-line">
        {CLIENTS.map((c, i) => (
          <button
            key={c.id}
            ref={(el) => {
              tabs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`tab-${c.id}`}
            aria-selected={i === active}
            aria-controls={`panel-${c.id}`}
            // Roving tabindex: one stop for the whole tablist, arrow keys move within it.
            tabIndex={i === active ? 0 : -1}
            onClick={() => setActive(i)}
            onKeyDown={onKeyDown}
            className={`-mb-px border-b px-4 py-3 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink ${
              i === active
                ? "border-ink text-ink"
                : "border-transparent text-mute hover:text-ink-3"
            }`}
          >
            {c.label}
          </button>
        ))}
      </div>

      <div
        role="tabpanel"
        id={`panel-${client.id}`}
        aria-labelledby={`tab-${client.id}`}
        tabIndex={0}
        className="pt-8 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ink"
      >
        <p className="stamp">In {client.where}</p>

        {client.heads_up !== undefined ? (
          <p className="mt-4 max-w-prose border-l-2 border-ink py-1 pl-4 text-sm leading-relaxed text-ink-2">
            {client.heads_up}
          </p>
        ) : null}

        <ol className="mt-6 max-w-prose">
          {client.steps.map((s, i) => (
            <li key={i} className="flex gap-5 border-t border-line py-4 first:border-t-0 first:pt-0">
              <span className="stamp mt-1 shrink-0 tabular-nums">
                {String(i + 1).padStart(2, "0")}
              </span>
              <span>
                <span className="block text-sm leading-relaxed text-ink">{s.do}</span>
                {s.why !== undefined ? (
                  <span className="mt-2 block text-sm leading-relaxed text-mute">{s.why}</span>
                ) : null}
              </span>
            </li>
          ))}
        </ol>

        <p className="mt-8 max-w-prose border-t border-line pt-4 text-sm leading-relaxed text-mute">
          {client.animates}
        </p>
      </div>
    </section>
  );
}
