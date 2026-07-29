const SOURCE_URL = "https://github.com/spykernv/signature-studio";

/** Who made it, and the source. The link is external and opens in place — a signature tool is
 *  not important enough to seize a second tab. */
export function Colophon() {
  return (
    <footer className="mt-20 border-t border-line py-8 sm:mt-24">
      <p className="mono text-[11px] tracking-[0.06em] text-mute">
        Made by Jonathan Naal.{" "}
        <a
          href={SOURCE_URL}
          className="text-ink-3 underline decoration-line-2 underline-offset-4 transition-colors hover:text-ink hover:decoration-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
        >
          Source on GitHub
        </a>
        .
      </p>
    </footer>
  );
}
