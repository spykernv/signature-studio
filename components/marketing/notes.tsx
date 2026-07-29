/**
 * The two blocks of prose under the hero: a statement of intent, then the three things about
 * e-mail signatures that people otherwise find out after they have installed one.
 *
 * They are prose and a list, not a feature grid, because none of them is a feature — one is a
 * design decision and three are constraints, and setting a constraint in a card with an icon
 * is how you make a reader stop believing it.
 */

const NOTES: ReadonlyArray<{ title: string; body: string }> = [
  {
    title: "Your photo never leaves your device",
    body:
      "The crop, the grading and every frame of the animation are computed in this tab. If you " +
      "publish, exactly one file is uploaded — the finished 224 by 276 greyscale GIF, because " +
      "your recipients' mail clients have to load it from somewhere. If you don't publish, " +
      "nothing is uploaded at all.",
  },
  {
    title: "You finish on a computer",
    body:
      "The Gmail and Outlook apps on a phone accept plain text in a signature and nothing " +
      "else — no images, no formatting, from any tool. Installing this one takes a desktop " +
      "browser, once.",
  },
  {
    title: "In a dark inbox it shows as a white card",
    body:
      "No mail client inverts images. The GIF carries its white background into dark mode, " +
      "where it sits as a white rectangle. That is true of every image in every signature; " +
      "there is no version of this that behaves differently.",
  },
];

export function BlackAndWhite() {
  return (
    <section aria-label="Why it is black and white" className="mt-16 sm:mt-20">
      <p className="max-w-[60ch] text-[17px] leading-relaxed text-ink-2 text-pretty">
        It is black and white by design. A colour photograph at this size turns into a smudge
        in an inbox and a colour signature reads as an advertisement; a graded greyscale one
        reads as a photograph, and it survives every client that renders it.
      </p>
    </section>
  );
}

export function Notes() {
  return (
    <section aria-labelledby="notes-heading" className="mt-16 sm:mt-20">
      <h2 id="notes-heading" className="stamp">
        Before you start
      </h2>
      <ul className="mt-6 divide-y divide-line border-t border-line">
        {NOTES.map((note) => (
          <li key={note.title} className="py-7">
            <h3 className="text-[15px] font-medium text-ink">{note.title}</h3>
            <p className="mt-2 max-w-[62ch] text-[15px] leading-relaxed text-ink-3 text-pretty">
              {note.body}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
