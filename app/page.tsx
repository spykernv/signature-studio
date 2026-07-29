import { Colophon } from "@/components/marketing/colophon";
import { Hero } from "@/components/marketing/hero";
import { BlackAndWhite, Notes } from "@/components/marketing/notes";

/**
 * One screen, then a little more. The order is the argument: the thing moving, the sentence
 * that names it, the one action, then what is true about e-mail signatures whether or not we
 * mention it. Nothing here is a section that could be deleted without losing information.
 */
export default function Home() {
  return (
    <div className="mx-auto w-full max-w-2xl px-6 sm:px-8">
      <header className="pt-8">
        <p className="stamp">Signature Studio</p>
      </header>

      <main>
        <Hero />
        <BlackAndWhite />
        <Notes />
      </main>

      <Colophon />
    </div>
  );
}
