import { Reveal } from "./components/reveal";
import { MobileNav } from "./components/mobile-nav";
import { HeroInstagramButton } from "./components/hero-instagram-button";

function GlassCard({
  children,
  className = "",
  hover = true,
}: {
  children: React.ReactNode;
  className?: string;
  hover?: boolean;
}) {
  return (
    <div
      className={`glass-card bg-white/40 backdrop-blur-2xl border border-white/60 shadow-[inset_0_1px_0_rgba(255,255,255,0.4),0_4px_24px_rgba(0,0,0,0.05)] rounded-2xl ${
        hover
          ? "transition-all duration-500 ease-out hover:-translate-y-1 hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.5),0_16px_48px_rgba(0,0,0,0.08)] hover:border-white/70"
          : ""
      } ${className}`}>
      {children}
    </div>
  );
}

export default function Home() {
  return (
    <div className="flex flex-col min-h-screen relative">
      {/* ================================================================== */}
      {/* Page-level atmospheric layer                                        */}
      {/* ================================================================== */}
      <div
        className="fixed inset-0 z-0 pointer-events-none overflow-hidden"
        aria-hidden="true">
        <div className="ambient-shape absolute top-[5%] left-[-5%] w-[700px] h-[700px] rounded-full bg-sage-300/60 blur-[120px]" />
        <div
          className="ambient-drift absolute top-[50%] right-[-8%] w-[600px] h-[600px] rounded-full bg-mist-300/50 blur-[110px]"
          style={{ animationDelay: "-10s" }}
        />
        <div
          className="ambient-shape absolute bottom-[10%] left-[20%] w-[500px] h-[500px] rounded-full bg-warm-300/55 blur-[100px]"
          style={{ animationDelay: "-18s" }}
        />
        <div
          className="ambient-drift absolute top-[25%] left-[50%] w-[400px] h-[400px] rounded-full bg-sage-200/50 blur-[100px]"
          style={{ animationDelay: "-6s" }}
        />
      </div>

      {/* ================================================================== */}
      {/* Navigation                                                         */}
      {/* ================================================================== */}
      <nav className="fixed top-4 left-4 right-4 z-40 mx-auto max-w-6xl">
        <div className="glass-card bg-white/50 backdrop-blur-2xl border border-white/60 rounded-2xl shadow-[inset_0_1px_0_rgba(255,255,255,0.4),0_4px_24px_rgba(0,0,0,0.05)] px-4 md:px-6 h-14 flex items-center justify-between">
          <a
            href="#"
            className="font-display text-lg md:text-xl tracking-tight text-warm-800">
            Eszter Gyori
          </a>
          <div className="hidden md:flex items-center gap-8">
            <a
              href="#prestations"
              className="text-sm text-warm-500 hover:text-warm-800 transition-colors duration-300">
              Prestations
            </a>
            <a
              href="#parcours"
              className="text-sm text-warm-500 hover:text-warm-800 transition-colors duration-300">
              Parcours
            </a>
            <a
              href="#realisations"
              className="text-sm text-warm-500 hover:text-warm-800 transition-colors duration-300">
              R&eacute;alisations
            </a>
            <a
              href="#a-propos"
              className="text-sm text-warm-500 hover:text-warm-800 transition-colors duration-300">
              &Agrave; propos
            </a>
            <a
              href="#contact"
              className="text-sm font-medium px-5 py-2 bg-warm-800 text-porcelain rounded-full hover:bg-warm-700 transition-all duration-300 hover:shadow-[0_4px_16px_rgba(44,43,40,0.2)]">
              Prendre contact
            </a>
          </div>
          <MobileNav />
        </div>
      </nav>

      {/* ================================================================== */}
      {/* Hero                                                                */}
      {/* ================================================================== */}
      <section className="relative z-10 min-h-svh md:min-h-[90vh] flex items-center pt-20 md:pt-24 pb-12 md:pb-16 px-4 md:px-6 overflow-hidden">
        <div className="ambient-shape absolute top-[8%] left-[2%] w-[550px] h-[550px] rounded-full bg-sage-300/65 blur-[100px] pointer-events-none" />
        <div
          className="ambient-drift absolute bottom-[0%] right-[5%] w-[500px] h-[500px] rounded-full bg-mist-300/50 blur-[90px] pointer-events-none"
          style={{ animationDelay: "-8s" }}
        />
        <div
          className="ambient-shape absolute top-[35%] right-[25%] w-[350px] h-[350px] rounded-full bg-warm-300/55 blur-[80px] pointer-events-none"
          style={{ animationDelay: "-16s" }}
        />

        <div className="relative z-10 max-w-6xl mx-auto grid grid-cols-1 md:grid-cols-2 gap-12 md:gap-20 items-center">
          <div className="space-y-8">
            <div className="hero-entrance w-10 h-px bg-sage-400/60" />
            <h1 className="hero-entrance-delayed font-display text-[2.25rem] sm:text-[2.75rem] md:text-[4.25rem] font-light leading-[1.08] tracking-[-0.02em] text-warm-800">
              Un maquillage permanent <em className="italic">naturel</em>,
              pens&eacute; pour r&eacute;v&eacute;ler votre visage.
            </h1>
            <p className="hero-entrance-delayed-2 text-base md:text-lg text-warm-500 leading-relaxed max-w-md">
              Dermopigmentation des sourcils, eye-liner, l&egrave;vres et faux
              freckles. Des r&eacute;sultats doux et durables, pr&egrave;s de
              Lille.
            </p>
            <div className="hero-entrance-delayed-3 flex flex-col sm:flex-row flex-wrap gap-3 sm:gap-4 pt-2">
              <a
                href="#prestations"
                className="inline-flex items-center justify-center px-7 py-3 sm:py-3.5 bg-warm-800 text-porcelain font-medium rounded-full hover:bg-warm-700 transition-all duration-300 hover:shadow-[0_8px_24px_rgba(44,43,40,0.2)] hover:scale-[1.02] active:scale-[0.98]">
                D&eacute;couvrir les prestations
              </a>
              <a
                href="#contact"
                className="inline-flex items-center justify-center px-7 py-3 sm:py-3.5 bg-white/50 backdrop-blur-sm border border-white/60 text-warm-600 font-medium rounded-full hover:bg-white/70 hover:border-white/80 transition-all duration-300 hover:shadow-[0_4px_16px_rgba(0,0,0,0.04)]">
                Prendre contact
              </a>
            </div>
          </div>

          <div className="hero-entrance-delayed-2 relative aspect-[3/4] max-w-md mx-auto md:mx-0">
            <div className="absolute -inset-8 bg-gradient-to-br from-sage-300/50 via-mist-200/60 to-warm-300/40 rounded-[3rem] blur-2xl pointer-events-none" />
            <div className="relative h-full rounded-3xl overflow-hidden bg-gradient-to-br from-sage-200 via-mist-100 to-warm-200 border border-white/40 shadow-[inset_0_1px_0_rgba(255,255,255,0.3),0_12px_48px_rgba(0,0,0,0.06)]">
              <div className="absolute inset-0 bg-gradient-to-t from-white/30 via-transparent to-white/10" />
              <div className="absolute inset-0 bg-gradient-to-br from-sage-300/25 via-transparent to-mist-200/20" />
              <div className="relative h-full flex flex-col items-center justify-center p-10">
                <div className="w-32 h-12 mb-5 border-b-[1.5px] border-sage-400/50 rounded-b-[55%]" />
                <div className="flex gap-3 mb-6">
                  <div className="w-2 h-2 rounded-full bg-sage-400/45" />
                  <div className="w-1.5 h-1.5 rounded-full bg-sage-400/35" />
                  <div className="w-1 h-1 rounded-full bg-sage-400/40" />
                  <div className="w-1.5 h-1.5 rounded-full bg-sage-400/35" />
                  <div className="w-2 h-2 rounded-full bg-sage-400/45" />
                </div>
                <p className="text-sm text-warm-500 text-center leading-relaxed max-w-[200px]">
                  Portrait beaut&eacute; ou r&eacute;sultat sourcils naturels
                </p>
              </div>
              <HeroInstagramButton />
              <div
                className="float-gentle absolute top-5 right-5 bg-white/55 backdrop-blur-md border border-white/45 rounded-xl px-3 py-1.5 shadow-[0_4px_16px_rgba(0,0,0,0.04)]"
                style={{ animationDelay: "-3s" }}>
                <p className="text-[10px] uppercase tracking-wider text-sage-500">
                  Naturel
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ================================================================== */}
      {/* Reassurance                                                         */}
      {/* ================================================================== */}
      <section className="relative z-10 py-16 md:py-32 px-4 md:px-6">
        <div className="absolute inset-0 bg-gradient-to-b from-warm-50/0 via-sage-100/70 to-warm-50/0 pointer-events-none" />
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-warm-300/60 to-transparent" />

        <Reveal className="relative z-10 max-w-5xl mx-auto">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-16 gap-y-14">
            <Reveal className="space-y-4" delay={0}>
              <div className="w-8 h-px bg-sage-400/50" />
              <h3 className="font-display text-2xl font-normal text-warm-800">
                R&eacute;sultat naturel
              </h3>
              <p className="text-warm-500 leading-relaxed">
                Chaque trait est pens&eacute; pour sublimer votre visage sans
                artificialit&eacute;. L&apos;objectif est toujours un
                r&eacute;sultat qui vous ressemble.
              </p>
            </Reveal>

            <Reveal className="space-y-4" delay={100}>
              <div className="w-8 h-px bg-sage-400/50" />
              <h3 className="font-display text-2xl font-normal text-warm-800">
                Analyse morphologique
              </h3>
              <p className="text-warm-500 leading-relaxed">
                Avant chaque s&eacute;ance, une &eacute;tude compl&egrave;te de
                votre visage permet de d&eacute;finir la forme et la teinte
                id&eacute;ales.
              </p>
            </Reveal>

            <Reveal className="space-y-4" delay={200}>
              <div className="w-8 h-px bg-sage-400/50" />
              <h3 className="font-display text-2xl font-normal text-warm-800">
                Hygi&egrave;ne et pr&eacute;cision
              </h3>
              <p className="text-warm-500 leading-relaxed">
                Mat&eacute;riel st&eacute;rile &agrave; usage unique, pigments
                certifi&eacute;s, protocoles stricts. Votre
                s&eacute;curit&eacute; est une priorit&eacute;.
              </p>
            </Reveal>

            <Reveal className="space-y-4" delay={300}>
              <div className="w-8 h-px bg-sage-400/50" />
              <h3 className="font-display text-2xl font-normal text-warm-800">
                Accompagnement personnalis&eacute;
              </h3>
              <p className="text-warm-500 leading-relaxed">
                De la premi&egrave;re consultation jusqu&apos;&agrave; la
                retouche, chaque &eacute;tape est expliqu&eacute;e et
                adapt&eacute;e &agrave; vos besoins.
              </p>
            </Reveal>
          </div>
        </Reveal>
      </section>

      {/* ================================================================== */}
      {/* Prestations                                                         */}
      {/* ================================================================== */}
      <section
        id="prestations"
        className="relative z-10 py-16 md:py-32 px-4 md:px-6 overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-warm-200/50 via-transparent to-sage-100/40 pointer-events-none" />
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-sage-300/50 to-transparent" />
        <div className="ambient-shape absolute bottom-[5%] left-[0%] w-[550px] h-[550px] rounded-full bg-sage-300/60 blur-[100px] pointer-events-none" />
        <div
          className="ambient-drift absolute top-[10%] right-[3%] w-[450px] h-[450px] rounded-full bg-mist-200/50 blur-[90px] pointer-events-none"
          style={{ animationDelay: "-12s" }}
        />

        <div className="relative z-10 max-w-6xl mx-auto">
          <Reveal className="mb-16 max-w-xl">
            <div className="w-10 h-px bg-sage-400/60 mb-6" />
            <h2 className="font-display text-3xl sm:text-4xl md:text-5xl font-light text-warm-800">
              Prestations
            </h2>
          </Reveal>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            <Reveal delay={0}>
              <GlassCard className="overflow-hidden group">
                <div className="aspect-[5/3] bg-gradient-to-br from-sage-200 via-mist-100 to-warm-200 relative overflow-hidden flex items-center justify-center transition-transform duration-700 group-hover:scale-[1.02]">
                  <div className="absolute inset-0 bg-gradient-to-t from-white/20 to-transparent" />
                  <div className="w-32 h-12 border-b-[1.5px] border-sage-400/50 rounded-b-[55%] relative z-10" />
                  <div className="absolute bottom-3 left-3 text-[11px] tracking-wide uppercase text-warm-500/80 relative z-10">
                    Photo &agrave; venir
                  </div>
                </div>
                <div className="p-7 space-y-3">
                  <h3 className="font-display text-2xl font-normal text-warm-800">
                    Sourcils
                  </h3>
                  <p className="text-warm-500 leading-relaxed">
                    Restructuration compl&egrave;te ou densification naturelle.
                    Technique adapt&eacute;e &agrave; votre type de peau et
                    &agrave; la forme de votre visage pour un r&eacute;sultat
                    harmonieux.
                  </p>
                  <a
                    href="#contact"
                    className="inline-block text-sm font-medium text-sage-600 hover:text-sage-500 transition-colors duration-300 group-hover:translate-x-1 transition-transform">
                    En savoir plus &rarr;
                  </a>
                </div>
              </GlassCard>
            </Reveal>

            <Reveal delay={100}>
              <GlassCard className="overflow-hidden group">
                <div className="aspect-[5/3] bg-gradient-to-br from-mist-200 via-sage-100 to-warm-200 relative overflow-hidden flex items-center justify-center transition-transform duration-700 group-hover:scale-[1.02]">
                  <div className="absolute inset-0 bg-gradient-to-t from-white/20 to-transparent" />
                  <div className="w-28 h-px bg-gradient-to-r from-transparent via-sage-400/50 to-transparent rotate-[-8deg] relative z-10" />
                  <div className="absolute bottom-3 left-3 text-[11px] tracking-wide uppercase text-warm-500/80 relative z-10">
                    Photo &agrave; venir
                  </div>
                </div>
                <div className="p-7 space-y-3">
                  <h3 className="font-display text-2xl font-normal text-warm-800">
                    Eye-liner
                  </h3>
                  <p className="text-warm-500 leading-relaxed">
                    Un trait subtil au ras des cils ou un eye-liner plus
                    marqu&eacute; selon vos envies. Le regard est
                    imm&eacute;diatement structur&eacute; et mis en valeur.
                  </p>
                  <a
                    href="#contact"
                    className="inline-block text-sm font-medium text-sage-600 hover:text-sage-500 transition-colors duration-300 group-hover:translate-x-1 transition-transform">
                    En savoir plus &rarr;
                  </a>
                </div>
              </GlassCard>
            </Reveal>

            <Reveal delay={200}>
              <GlassCard className="overflow-hidden group">
                <div className="aspect-[5/3] bg-gradient-to-br from-warm-300/80 via-mist-100 to-sage-100 relative overflow-hidden flex items-center justify-center transition-transform duration-700 group-hover:scale-[1.02]">
                  <div className="absolute inset-0 bg-gradient-to-t from-white/20 to-transparent" />
                  <div className="relative w-14 h-9 z-10">
                    <div className="absolute top-0 left-1/2 -translate-x-1/2 w-9 h-[18px] rounded-t-full border-t-[1.5px] border-x-[1.5px] border-warm-400/45" />
                    <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-11 h-[18px] rounded-b-full border-b-[1.5px] border-x-[1.5px] border-warm-400/45" />
                  </div>
                  <div className="absolute bottom-3 left-3 text-[11px] tracking-wide uppercase text-warm-500/80 relative z-10">
                    Photo &agrave; venir
                  </div>
                </div>
                <div className="p-7 space-y-3">
                  <h3 className="font-display text-2xl font-normal text-warm-800">
                    L&egrave;vres
                  </h3>
                  <p className="text-warm-500 leading-relaxed">
                    Contour, remplissage ou candy lips. Retrouvez une couleur
                    uniforme et un contour d&eacute;fini, adapt&eacute;s
                    &agrave; votre carnation naturelle.
                  </p>
                  <a
                    href="#contact"
                    className="inline-block text-sm font-medium text-sage-600 hover:text-sage-500 transition-colors duration-300 group-hover:translate-x-1 transition-transform">
                    En savoir plus &rarr;
                  </a>
                </div>
              </GlassCard>
            </Reveal>

            <Reveal delay={300}>
              <GlassCard className="overflow-hidden group">
                <div className="aspect-[5/3] bg-gradient-to-br from-warm-200 via-warm-300/60 to-sage-200 relative overflow-hidden flex items-center justify-center transition-transform duration-700 group-hover:scale-[1.02]">
                  <div className="absolute inset-0 bg-gradient-to-t from-white/20 to-transparent" />
                  <div className="relative w-20 h-20 z-10">
                    <div className="absolute top-2 left-5 w-2 h-2 rounded-full bg-warm-500/40" />
                    <div className="absolute top-6 left-1 w-1.5 h-1.5 rounded-full bg-warm-400/35" />
                    <div className="absolute top-4 left-10 w-1.5 h-1.5 rounded-full bg-warm-500/38" />
                    <div className="absolute top-10 left-4 w-2 h-2 rounded-full bg-warm-400/42" />
                    <div className="absolute top-8 left-12 w-1 h-1 rounded-full bg-warm-500/32" />
                    <div className="absolute top-14 left-8 w-1.5 h-1.5 rounded-full bg-warm-400/38" />
                    <div className="absolute top-12 left-14 w-2 h-2 rounded-full bg-warm-500/40" />
                  </div>
                  <div className="absolute bottom-3 left-3 text-[11px] tracking-wide uppercase text-warm-500/80 relative z-10">
                    Photo &agrave; venir
                  </div>
                </div>
                <div className="p-7 space-y-3">
                  <h3 className="font-display text-2xl font-normal text-warm-800">
                    Faux freckles
                  </h3>
                  <p className="text-warm-500 leading-relaxed">
                    Des taches de rousseur d&eacute;licates et r&eacute;alistes,
                    plac&eacute;es une &agrave; une pour un effet soleil
                    naturel. Technique fine et personnalis&eacute;e.
                  </p>
                  <a
                    href="#contact"
                    className="inline-block text-sm font-medium text-sage-600 hover:text-sage-500 transition-colors duration-300 group-hover:translate-x-1 transition-transform">
                    En savoir plus &rarr;
                  </a>
                </div>
              </GlassCard>
            </Reveal>
          </div>
        </div>
      </section>

      {/* ================================================================== */}
      {/* Parcours client                                                     */}
      {/* ================================================================== */}
      <section
        id="parcours"
        className="relative z-10 py-16 md:py-32 px-4 md:px-6 overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-b from-sage-100/60 via-sage-100/80 to-sage-100/50 pointer-events-none" />
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-warm-300/60 to-transparent" />
        <div
          className="ambient-shape absolute top-[20%] left-[15%] w-[450px] h-[450px] rounded-full bg-sage-300/50 blur-[90px] pointer-events-none"
          style={{ animationDelay: "-5s" }}
        />

        <div className="relative z-10 max-w-6xl mx-auto">
          <Reveal className="mb-16 max-w-xl">
            <div className="w-10 h-px bg-sage-400/60 mb-6" />
            <h2 className="font-display text-3xl sm:text-4xl md:text-5xl font-light text-warm-800">
              Comment se d&eacute;roule une s&eacute;ance
            </h2>
          </Reveal>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-8 sm:gap-10 lg:gap-8">
            <Reveal className="space-y-5" delay={0}>
              <span className="font-display text-5xl font-light text-sage-300/80">
                01
              </span>
              <h3 className="text-lg font-medium text-warm-800">
                &Eacute;change et analyse
              </h3>
              <p className="text-sm text-warm-500 leading-relaxed">
                On discute de vos attentes et j&apos;analyse votre visage pour
                d&eacute;finir ensemble la forme et la teinte les plus
                adapt&eacute;es.
              </p>
            </Reveal>

            <Reveal className="space-y-5" delay={100}>
              <span className="font-display text-5xl font-light text-sage-300/80">
                02
              </span>
              <h3 className="text-lg font-medium text-warm-800">
                Dessin et validation
              </h3>
              <p className="text-sm text-warm-500 leading-relaxed">
                Un dessin pr&eacute;alable est r&eacute;alis&eacute; directement
                sur votre peau. Rien n&apos;est d&eacute;finitif tant que vous
                n&apos;avez pas valid&eacute;.
              </p>
            </Reveal>

            <Reveal className="space-y-5" delay={200}>
              <span className="font-display text-5xl font-light text-sage-300/80">
                03
              </span>
              <h3 className="text-lg font-medium text-warm-800">
                R&eacute;alisation
              </h3>
              <p className="text-sm text-warm-500 leading-relaxed">
                La pigmentation est r&eacute;alis&eacute;e avec
                pr&eacute;cision, dans un environnement calme et confortable.
                S&eacute;ance d&apos;environ 2 heures.
              </p>
            </Reveal>

            <Reveal className="space-y-5" delay={300}>
              <span className="font-display text-5xl font-light text-sage-300/80">
                04
              </span>
              <h3 className="text-lg font-medium text-warm-800">
                Cicatrisation et retouche
              </h3>
              <p className="text-sm text-warm-500 leading-relaxed">
                Le r&eacute;sultat final appara&icirc;t apr&egrave;s
                cicatrisation. Une retouche est pr&eacute;vue 4 &agrave; 6
                semaines apr&egrave;s pour parfaire le r&eacute;sultat.
              </p>
            </Reveal>
          </div>
        </div>
      </section>

      {/* ================================================================== */}
      {/* R&eacute;alisations                                                 */}
      {/* ================================================================== */}
      <section
        id="realisations"
        className="relative z-10 py-16 md:py-32 px-4 md:px-6 overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-b from-warm-50/0 via-warm-200/60 to-warm-50/0 pointer-events-none" />
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-sage-300/50 to-transparent" />
        <div className="ambient-drift absolute top-[5%] right-[5%] w-[500px] h-[500px] rounded-full bg-mist-300/50 blur-[100px] pointer-events-none" />
        <div
          className="ambient-shape absolute bottom-[5%] left-[8%] w-[400px] h-[400px] rounded-full bg-sage-200/55 blur-[90px] pointer-events-none"
          style={{ animationDelay: "-10s" }}
        />

        <div className="relative z-10 max-w-6xl mx-auto">
          <Reveal className="mb-16 max-w-xl">
            <div className="w-10 h-px bg-sage-400/60 mb-6" />
            <h2 className="font-display text-3xl sm:text-4xl md:text-5xl font-light text-warm-800">
              R&eacute;alisations
            </h2>
          </Reveal>

          <div className="grid grid-cols-2 md:grid-cols-3 gap-3 sm:gap-4 md:gap-6">
            <Reveal className="col-span-2" delay={0}>
              <div className="rounded-2xl overflow-hidden bg-gradient-to-br from-sage-200 via-mist-100 to-warm-200 border border-white/40 shadow-[0_4px_24px_rgba(0,0,0,0.05)] group transition-shadow duration-500 hover:shadow-[0_8px_32px_rgba(0,0,0,0.08)]">
                <div className="aspect-[16/9] flex items-center justify-center relative overflow-hidden">
                  <div className="absolute inset-0 bg-gradient-to-t from-white/15 to-transparent" />
                  <div className="flex gap-8 items-center relative z-10 transition-transform duration-700 group-hover:scale-[1.03]">
                    <div className="w-16 h-10 border-b-[1.5px] border-sage-400/45 rounded-b-[50%]" />
                    <div className="w-px h-6 bg-warm-400/50" />
                    <div className="w-16 h-10 border-b-[1.5px] border-sage-400/50 rounded-b-[50%]" />
                  </div>
                  <div className="absolute bottom-4 left-4 text-[11px] tracking-wide uppercase text-warm-500/80">
                    Avant / Apr&egrave;s
                  </div>
                </div>
                <div className="px-5 py-4">
                  <p className="text-sm font-medium text-warm-600">
                    Sourcils naturels
                  </p>
                </div>
              </div>
            </Reveal>

            <Reveal delay={100}>
              <div className="rounded-2xl overflow-hidden bg-gradient-to-br from-warm-200 via-sage-100 to-mist-100 border border-white/40 shadow-[0_4px_24px_rgba(0,0,0,0.05)] group transition-shadow duration-500 hover:shadow-[0_8px_32px_rgba(0,0,0,0.08)]">
                <div className="aspect-square flex items-center justify-center relative overflow-hidden">
                  <div className="absolute inset-0 bg-gradient-to-t from-white/15 to-transparent" />
                  <div className="w-20 h-8 border-b-[1.5px] border-sage-400/45 rounded-b-[48%] relative z-10 transition-transform duration-700 group-hover:scale-[1.03]" />
                  <div className="absolute bottom-4 left-4 text-[11px] tracking-wide uppercase text-warm-500/80">
                    Cicatrisation
                  </div>
                </div>
                <div className="px-5 py-4">
                  <p className="text-sm font-medium text-warm-600">
                    Sourcils cicatris&eacute;s
                  </p>
                </div>
              </div>
            </Reveal>

            <Reveal delay={200}>
              <div className="rounded-2xl overflow-hidden bg-gradient-to-br from-mist-200 via-sage-100 to-warm-100 border border-white/40 shadow-[0_4px_24px_rgba(0,0,0,0.05)] group transition-shadow duration-500 hover:shadow-[0_8px_32px_rgba(0,0,0,0.08)]">
                <div className="aspect-square flex items-center justify-center relative overflow-hidden">
                  <div className="absolute inset-0 bg-gradient-to-t from-white/15 to-transparent" />
                  <div className="w-24 h-px bg-gradient-to-r from-transparent via-sage-400/50 to-transparent rotate-[-6deg] relative z-10 transition-transform duration-700 group-hover:scale-[1.03]" />
                  <div className="absolute bottom-4 left-4 text-[11px] tracking-wide uppercase text-warm-500/80">
                    R&eacute;sultat
                  </div>
                </div>
                <div className="px-5 py-4">
                  <p className="text-sm font-medium text-warm-600">
                    Eye-liner d&eacute;licat
                  </p>
                </div>
              </div>
            </Reveal>

            <Reveal delay={250}>
              <div className="rounded-2xl overflow-hidden bg-gradient-to-br from-warm-300/70 via-mist-100 to-sage-100 border border-white/40 shadow-[0_4px_24px_rgba(0,0,0,0.05)] group transition-shadow duration-500 hover:shadow-[0_8px_32px_rgba(0,0,0,0.08)]">
                <div className="aspect-square flex items-center justify-center relative overflow-hidden">
                  <div className="absolute inset-0 bg-gradient-to-t from-white/15 to-transparent" />
                  <div className="relative w-12 h-8 z-10 transition-transform duration-700 group-hover:scale-[1.03]">
                    <div className="absolute top-0 left-1/2 -translate-x-1/2 w-8 h-4 rounded-t-full border-t-[1.5px] border-x-[1.5px] border-warm-400/40" />
                    <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-10 h-4 rounded-b-full border-b-[1.5px] border-x-[1.5px] border-warm-400/40" />
                  </div>
                  <div className="absolute bottom-4 left-4 text-[11px] tracking-wide uppercase text-warm-500/80">
                    Avant / Apr&egrave;s
                  </div>
                </div>
                <div className="px-5 py-4">
                  <p className="text-sm font-medium text-warm-600">
                    L&egrave;vres poudr&eacute;es
                  </p>
                </div>
              </div>
            </Reveal>

            <Reveal delay={300}>
              <div className="rounded-2xl overflow-hidden bg-gradient-to-br from-sage-200/80 via-warm-200 to-mist-100 border border-white/40 shadow-[0_4px_24px_rgba(0,0,0,0.05)] group transition-shadow duration-500 hover:shadow-[0_8px_32px_rgba(0,0,0,0.08)]">
                <div className="aspect-square flex items-center justify-center relative overflow-hidden">
                  <div className="absolute inset-0 bg-gradient-to-t from-white/15 to-transparent" />
                  <div className="relative w-16 h-16 z-10 transition-transform duration-700 group-hover:scale-[1.03]">
                    <div className="absolute top-1 left-3 w-2 h-2 rounded-full bg-warm-500/38" />
                    <div className="absolute top-4 left-8 w-1.5 h-1.5 rounded-full bg-warm-400/32" />
                    <div className="absolute top-7 left-1 w-1.5 h-1.5 rounded-full bg-warm-500/38" />
                    <div className="absolute top-10 left-6 w-2 h-2 rounded-full bg-warm-400/35" />
                    <div className="absolute top-6 left-12 w-1 h-1 rounded-full bg-warm-500/30" />
                  </div>
                  <div className="absolute bottom-4 left-4 text-[11px] tracking-wide uppercase text-warm-500/80">
                    R&eacute;sultat
                  </div>
                </div>
                <div className="px-5 py-4">
                  <p className="text-sm font-medium text-warm-600">
                    Faux freckles
                  </p>
                </div>
              </div>
            </Reveal>
          </div>

          <Reveal className="mt-14 flex justify-center">
            <a
              href="https://www.instagram.com/eg_maquillagepermanent/"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center gap-2 px-7 py-3.5 bg-white/50 backdrop-blur-sm border border-white/60 text-warm-600 font-medium rounded-full hover:bg-white/70 hover:border-white/80 transition-all duration-300 hover:shadow-[0_4px_16px_rgba(0,0,0,0.04)]">
              Voir plus sur Instagram
            </a>
          </Reveal>
        </div>
      </section>

      {/* ================================================================== */}
      {/* &Agrave; propos                                                     */}
      {/* ================================================================== */}
      <section
        id="a-propos"
        className="relative z-10 py-16 md:py-32 px-4 md:px-6 overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-b from-sage-100/50 via-warm-200/60 to-warm-100/40 pointer-events-none" />
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-warm-300/60 to-transparent" />
        <div
          className="ambient-drift absolute bottom-[10%] right-[5%] w-[450px] h-[450px] rounded-full bg-sage-300/45 blur-[90px] pointer-events-none"
          style={{ animationDelay: "-7s" }}
        />

        <Reveal className="relative z-10 max-w-5xl mx-auto grid grid-cols-1 md:grid-cols-5 gap-12 md:gap-16 items-start">
          <div className="md:col-span-2 relative">
            <div className="absolute -inset-6 bg-gradient-to-br from-sage-300/35 to-mist-200/30 rounded-[2rem] blur-xl pointer-events-none" />
            <div className="relative aspect-[3/4] rounded-2xl overflow-hidden bg-gradient-to-br from-sage-200 via-mist-100 to-warm-200 border border-white/40 shadow-[inset_0_1px_0_rgba(255,255,255,0.3),0_12px_40px_rgba(0,0,0,0.06)] flex items-center justify-center p-8 group transition-shadow duration-500 hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.3),0_16px_48px_rgba(0,0,0,0.08)]">
              <div className="absolute inset-0 bg-gradient-to-t from-white/20 via-transparent to-white/10" />
              <p className="text-sm text-warm-500 text-center leading-relaxed relative z-10">
                Portrait professionnel d&apos;Eszter
              </p>
            </div>
          </div>
          <div className="md:col-span-3 space-y-6 md:pt-4">
            <div className="w-10 h-px bg-sage-400/60" />
            <h2 className="font-display text-3xl sm:text-4xl md:text-5xl font-light text-warm-800">
              Eszter Gyori
            </h2>
            <div className="space-y-5 pt-2">
              <p className="text-warm-500 leading-[1.8]">
                Sp&eacute;cialiste en dermopigmentation install&eacute;e
                pr&egrave;s de Lille, je pratique le maquillage permanent avec
                une approche centr&eacute;e sur le naturel et la
                pr&eacute;cision.
              </p>
              <p className="text-warm-500 leading-[1.8]">
                Mon objectif est simple : sublimer vos traits sans les
                transformer. Chaque visage est unique, et chaque prestation est
                pens&eacute;e sur mesure, dans le respect de votre morphologie
                et de vos envies.
              </p>
              <p className="text-warm-500 leading-[1.8]">
                Form&eacute;e aux techniques les plus r&eacute;centes, je
                m&apos;engage &agrave; travailler avec des pigments
                certifi&eacute;s et du mat&eacute;riel st&eacute;rile &agrave;
                usage unique, pour votre s&eacute;curit&eacute; et votre
                tranquillit&eacute; d&apos;esprit.
              </p>
            </div>
          </div>
        </Reveal>
      </section>

      {/* ================================================================== */}
      {/* Contact CTA                                                         */}
      {/* ================================================================== */}
      <section
        id="contact"
        className="relative z-10 py-16 md:py-32 px-4 md:px-6 overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-sage-100/60 via-mist-100/50 to-warm-200/50 pointer-events-none" />
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-sage-300/50 to-transparent" />
        <div className="ambient-shape absolute top-[5%] left-[10%] w-[500px] h-[500px] rounded-full bg-sage-300/55 blur-[100px] pointer-events-none" />
        <div
          className="ambient-drift absolute bottom-[5%] right-[5%] w-[450px] h-[450px] rounded-full bg-mist-300/45 blur-[90px] pointer-events-none"
          style={{ animationDelay: "-14s" }}
        />

        <Reveal className="relative z-10 max-w-2xl mx-auto">
          <GlassCard
            hover={false}
            className="p-6 sm:p-10 md:p-16 text-center space-y-6 sm:space-y-8 rounded-3xl">
            <div className="w-10 h-px bg-sage-400/60 mx-auto" />
            <h2 className="font-display text-2xl sm:text-3xl md:text-[2.75rem] font-light leading-tight text-warm-800">
              &Eacute;changeons sur votre projet
            </h2>
            <p className="text-warm-500 leading-relaxed max-w-md mx-auto">
              Vous avez des questions ou souhaitez prendre rendez-vous ? Je vous
              r&eacute;ponds avec plaisir pour discuter de vos envies et vous
              accompagner dans votre d&eacute;marche.
            </p>
            <div className="flex flex-col sm:flex-row gap-4 justify-center pt-2">
              <a
                href="https://www.instagram.com/eg_maquillagepermanent/"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center justify-center px-7 py-3.5 bg-warm-800 text-porcelain font-medium rounded-full hover:bg-warm-700 transition-all duration-300 hover:shadow-[0_8px_24px_rgba(44,43,40,0.2)] hover:scale-[1.02] active:scale-[0.98]">
                &Eacute;crire sur Instagram
              </a>
              <a
                href="mailto:contact@esztergyori.com"
                className="inline-flex items-center justify-center px-7 py-3.5 bg-white/50 backdrop-blur-sm border border-white/60 text-warm-600 font-medium rounded-full hover:bg-white/70 hover:border-white/80 transition-all duration-300 hover:shadow-[0_4px_16px_rgba(0,0,0,0.04)]">
                Envoyer un email
              </a>
            </div>
          </GlassCard>
        </Reveal>
      </section>

      {/* ================================================================== */}
      {/* Footer                                                              */}
      {/* ================================================================== */}
      <footer className="relative z-10 border-t border-warm-300/50 py-8 md:py-10 px-4 md:px-6 bg-gradient-to-b from-warm-100/60 to-warm-200/40">
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row justify-between items-center gap-4">
          <p className="text-sm text-warm-400">
            &copy; {new Date().getFullYear()} {""} Eszter Gyori. Tous droits
            r&eacute;serv&eacute;s.
          </p>
          <div className="flex gap-6 text-sm text-warm-400">
            <a
              href="https://www.instagram.com/eg_maquillagepermanent/"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-warm-600 transition-colors duration-300">
              Instagram
            </a>
            <a
              href="mailto:contact@esztergyori.com"
              className="hover:text-warm-600 transition-colors duration-300">
              Contact
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
