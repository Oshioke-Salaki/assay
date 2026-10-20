import Image from "next/image";
import Link from "next/link";
import { AddressForm } from "@/components/AddressForm";
import { Footer } from "@/components/Footer";
import { GrossSwitch } from "@/components/GrossSwitch";
import { Hallmark } from "@/components/Hallmark";
import { Reveal } from "@/components/Reveal";
import { SellerIndex } from "@/components/SellerIndex";
import { SiteBar } from "@/components/SiteBar";
import { type Economy, tryApi } from "@/lib/api";
import { fineness, int, usd } from "@/lib/format";
import styles from "./landing.module.css";

export const revalidate = 30;

const FOLDERS = [
  { href: "#test", label: "The test", color: "var(--silver)", offset: "8%" },
  { href: "#gross", label: "Gross or real", color: "var(--slate)", offset: "30%", dark: true },
  { href: "#sellers", label: "Sellers", color: "var(--gold)", offset: "52%" },
  { href: "#report", label: "Inside a report", color: "var(--ash)", offset: "72%" },
];

export default async function Home() {
  const e = await tryApi<Economy>("/v1/economy");
  const gross = e?.grossUsd ?? 0;
  const organic = e?.organicUsd ?? 0;
  const loop = e?.loopOffsetUsd ?? 0;
  const funded = e?.fundedUsd ?? 0;
  const fine = fineness(organic, gross);
  const afterLoops = gross - loop;
  const sampleAgent = e?.topSellers.find((x) => x.agentIds.length > 0)?.agentIds[0] ?? null;

  return (
    <>
      <Reveal />
      <div className={styles.hero}>
        <SiteBar />
        <div className={styles.heroCopy}>
          <h1 className={styles.title}>Assay</h1>
          <p className={styles.lede}>
            The credit bureau for agent payments on Celo. It tests every x402 seller&rsquo;s revenue for what
            is real and what is money going in circles.
          </p>
        </div>
        <div className={styles.stack}>
          {FOLDERS.map((f, i) => (
            <a
              key={f.href}
              href={f.href}
              className={`${styles.folder} ${f.dark ? styles.folderDark : ""}`}
              style={{ background: f.color, top: `${i * 56}px`, "--tab-x": f.offset } as React.CSSProperties}
            >
              <span className={styles.tab}>{f.label}</span>
            </a>
          ))}
          <section className={styles.front} id="assay" aria-labelledby="assay-h">
            <span className={styles.tab} aria-hidden="true">
              Assay
            </span>
            <div className={styles.frontGrid}>
              <div>
                <h2 id="assay-h" className={styles.frontHead}>
                  {fine === null ? "Celo x402 is being assayed" : `Celo x402 assays at 0.${fine} fine`}
                </h2>
                <p className={styles.frontLine}>
                  {e
                    ? `${usd(organic)} of the ${usd(gross)} settled over x402 on Celo is organic. The rest went round in loops or came from wallets the seller funded.`
                    : "The live figures could not be loaded just now. Paste an address to assay it directly."}
                </p>
              </div>
              <div className={styles.frontForm}>
                <AddressForm tone="accent" />
                {e && e.topSellers.length > 0 ? (
                  <p className={styles.tryLine}>
                    Or try the top organic seller,{" "}
                    <Link className="link" href={`/address/${e.topSellers[0]!.address}`}>
                      {e.topSellers[0]!.address.slice(0, 10)}…
                    </Link>
                    .
                  </p>
                ) : null}
              </div>
            </div>
          </section>
        </div>
      </div>

      <section className={styles.intro} aria-label="What an assay is">
        <p className={styles.statement} data-reveal="0">
          An assayer fires the sample{" "}
          <span className={styles.thumb}>
            <Image
              src="/img/cupels-for-assays-and-refining-noble-metals.jpg"
              alt=""
              width={1920}
              height={1440}
            />
          </span>
          , weighs what survives{" "}
          <span className={styles.thumb}>
            <Image
              src="/img/modern-analytical-short-beam-balance-from-notes.jpg"
              alt=""
              width={1547}
              height={1675}
            />
          </span>{" "}
          and strikes a hallmark{" "}
          <span className={styles.thumb}>
            <Image src="/img/spoon-stuerler-hallmarks.jpg" alt="" width={1920} height={2560} />
          </span>
          . Assay does that to agent revenue.
        </p>
        <figure className={styles.introPlate} data-reveal="1">
          <Image
            src="/img/ore-testing-and-ovens-in-assay-laboratory.jpg"
            alt="Woodcut of an assay laboratory with furnaces and assayers at work, from Lazarus Ercker's treatise, 1598"
            width={1137}
            height={1536}
            sizes="(max-width: 860px) 60vw, 18vw"
          />
          <figcaption>An assay laboratory, Lazarus Ercker, 1598.</figcaption>
        </figure>
        <figure className={styles.introPlate2} data-reveal="2">
          <video
            autoPlay
            muted
            loop
            playsInline
            preload="metadata"
            poster="/video/foundry-poster.jpg"
            aria-label="Foundry workers tending molten metal at a furnace"
            width={540}
            height={720}
          >
            <source src="/video/foundry.webm" type="video/webm" />
            <source src="/video/foundry.mp4" type="video/mp4" />
          </video>
          <Image
            className={styles.still}
            src="/video/foundry-poster.jpg"
            alt="Foundry workers tending molten metal at a furnace"
            width={540}
            height={720}
            sizes="18vw"
          />
          <figcaption>Metal at the furnace in a working foundry.</figcaption>
        </figure>
      </section>

      <section className={styles.test} id="test" aria-labelledby="test-h">
        {[
          {
            clause: "First, every settlement is read.",
            bg: "var(--silver)",
            card: (
              <>
                <p className={styles.cardLabel}>Settled over x402</p>
                <p className={styles.cardFig}>{usd(gross)}</p>
                <p className={styles.cardMeta}>
                  {int(e?.settlements)} settlements to {int(e?.sellers)} sellers
                </p>
              </>
            ),
          },
          {
            clause: "Then loops are netted out.",
            bg: "var(--ash)",
            card: (
              <>
                <p className={styles.cardLabel}>After loops</p>
                <p className={styles.cardFig}>{usd(afterLoops)}</p>
                <p className={styles.cardMeta}>
                  −{usd(loop)} that came back from {int(e?.loops)} loop{e?.loops === 1 ? "" : "s"} of up to{" "}
                  {int(e?.largestLoop)} wallets
                </p>
              </>
            ),
          },
          {
            clause: "Then self-funded payers are struck.",
            bg: "var(--gold)",
            card: (
              <>
                <p className={styles.cardLabel}>After funding trace</p>
                <p className={styles.cardFig}>{usd(afterLoops - funded)}</p>
                <p className={styles.cardMeta}>−{usd(funded)} paid by wallets the seller funded</p>
              </>
            ),
          },
          {
            clause: "What survives is the fineness.",
            bg: "var(--slate)",
            dark: true,
            card: (
              <>
                <p className={styles.cardLabel}>Organic</p>
                <p className={styles.cardFig}>{usd(organic)}</p>
                <Hallmark
                  organicUsd={organic}
                  grossUsd={gross}
                  rating="NR"
                  size="sm"
                  label="Celo x402 economy"
                />
              </>
            ),
          },
        ].map((f, i) => (
          <div
            key={f.clause}
            className={`${styles.testField} ${f.dark ? styles.testDark : ""}`}
            style={{ background: f.bg }}
          >
            {i === 0 ? (
              <h2 id="test-h" className={styles.testHead} data-reveal="0">
                The test
              </h2>
            ) : null}
            <div className={styles.card} data-ui data-reveal={String(i + 1)}>
              {f.card}
            </div>
            <p className={styles.clause} data-reveal={String(i + 2)}>
              {f.clause}
            </p>
          </div>
        ))}
      </section>

      <GrossSwitch grossUsd={gross} organicUsd={organic} settlements={e?.settlements ?? 0} />

      <section className={styles.sellers} id="sellers" aria-labelledby="sellers-h">
        <div className={styles.sellersHead}>
          <h2 id="sellers-h" className={styles.sectionHead} data-reveal="0">
            Sellers, by what is real
          </h2>
          <p className={styles.sectionLine} data-reveal="1">
            Ranked by organic revenue, not gross. {int(e?.organicPayers)} of {int(e?.payers)} paying wallets
            on Celo bought something from someone outside their own loop.
          </p>
        </div>
        <SellerIndex rows={(e?.topSellers ?? []).slice(0, 8)} />
        <p className={styles.sellersMore}>
          <Link className="link" href="/economy">
            See the whole economy
          </Link>
        </p>
      </section>

      <section className={styles.board} id="report" aria-labelledby="report-h">
        <div className={`${styles.tile} ${styles.t6x2} ${styles.tileAccent}`} data-reveal="0">
          <h2 id="report-h" className={styles.boardHead}>
            Inside a report
          </h2>
        </div>
        <div
          className={`${styles.tile} ${styles.t6x2}`}
          style={{ background: "var(--slate)", color: "var(--ink-on-dark)" }}
        >
          <div className={styles.macro} data-ui style={{ right: 20, top: 20 }}>
            <span className={styles.flagBlock}>Circular revenue</span>
          </div>
          <p className={styles.tileName}>Loop detection</p>
          <p className={styles.tileLine}>Money a seller sends back into its own loop is netted out.</p>
        </div>
        <div
          className={`${styles.tile} ${styles.t6x4}`}
          data-reveal="1"
          style={{ background: "var(--gold)" }}
        >
          <div className={`${styles.macro} ${styles.hallmarkMacro}`} data-ui>
            <Hallmark organicUsd={912} grossUsd={1000} rating="AA" size="fluid" />
          </div>
          <p className={styles.tileName}>The hallmark</p>
          <p className={styles.tileLine}>Rating, fineness and the office mark, struck in one row.</p>
        </div>
        <div className={`${styles.tile} ${styles.t3x4}`} data-reveal="1" style={{ background: "var(--ash)" }}>
          <div className={styles.macro} data-ui style={{ left: 20, top: 20 }}>
            <span className={styles.keyline}>funded by</span>
            <span className={styles.keycap}>0x486b…715f</span>
          </div>
          <p className={styles.tileName}>Funding trace</p>
          <p className={styles.tileLine}>Payers the seller funded, even one hop back, count for nothing.</p>
        </div>
        <div
          className={`${styles.tile} ${styles.t3x4}`}
          data-reveal="1"
          style={{ background: "var(--silver)" }}
        >
          <div className={styles.macro} data-ui style={{ left: 20, top: 20 }}>
            <span className={styles.verdict}>block</span>
          </div>
          <p className={styles.tileName}>Pre-payment check</p>
          <p className={styles.tileLine}>Pass, caution or block, before the money moves.</p>
        </div>
        <div className={`${styles.tile} ${styles.t3x2}`} data-reveal="1" style={{ background: "var(--ash)" }}>
          <div className={styles.macro} data-ui style={{ left: 20, top: 20 }}>
            <span className={styles.human}>One human</span>
          </div>
          <p className={styles.tileName}>Self Agent ID</p>
          <p className={styles.tileLine}>Payers proven to be one human count once.</p>
        </div>
        <div
          className={`${styles.tile} ${styles.t3x2}`}
          data-reveal="1"
          style={{ background: "var(--gold)" }}
        >
          <div className={styles.macro} data-ui style={{ left: 20, top: 16 }}>
            <span className={styles.bigNum}>{sampleAgent ? `#${sampleAgent}` : "8004"}</span>
          </div>
          <p className={styles.tileName}>ERC-8004 identity</p>
          <p className={styles.tileLine}>Linked to the agent&rsquo;s onchain registration.</p>
        </div>
        <div
          className={`${styles.tile} ${styles.t3x2}`}
          style={{ background: "var(--slate)", color: "var(--ink-on-dark)" }}
        >
          <div className={styles.macro} data-ui style={{ left: 20, top: 16 }}>
            <span className={styles.bigNum}>$0.002</span>
          </div>
          <p className={styles.tileName}>Priced per call</p>
          <p className={styles.tileLine}>Agents pay in USA₮ over x402.</p>
        </div>
        <div
          className={`${styles.tile} ${styles.t3x2}`}
          data-reveal="1"
          style={{ background: "var(--silver)" }}
        >
          <div className={styles.macro} data-ui style={{ left: 20, top: 20 }}>
            <span className={styles.keycap}>EIP-712</span>
          </div>
          <p className={styles.tileName}>Signed score</p>
          <p className={styles.tileLine}>EIP-712, verified by AssayRegistry on Celo.</p>
        </div>
      </section>

      <section className={styles.rails} aria-labelledby="rails-h">
        <div className={`${styles.railTile} ${styles.railHead}`} data-reveal="0">
          <h2 id="rails-h" className={styles.boardHead}>
            Built on open rails
          </h2>
          <p className={styles.tileLine}>
            Every figure is read from Celo mainnet and can be checked on an explorer.
          </p>
        </div>
        {[
          ["x402", "Every settlement through the Celo facilitator and the x402 Permit2 proxy."],
          ["ERC-8004", "Agent identities and every review in the Reputation Registry."],
          ["Self Agent ID", "Passport-backed proof that a key belongs to one human."],
          ["ERC-8021", "Attribution tags on every transaction Assay sends."],
          ["USA₮", "The token agents pay Assay in, alongside USDC and USDT."],
          ["Ripio wFIAT", "wARS, wBRL and wCOP settlements, priced at the day's rate."],
        ].map(([name, line]) => (
          <div key={name} className={styles.railTile} data-reveal="1">
            <p className={styles.railName}>{name}</p>
            <p className={styles.tileLine}>{line}</p>
          </div>
        ))}
      </section>

      <section className={styles.pricing} id="pricing" aria-labelledby="pricing-h">
        <h2 id="pricing-h" className="sr-only">
          Pricing
        </h2>
        <div className={styles.plan} style={{ background: "var(--ash)" }}>
          <h3 className={styles.planName} data-reveal="0">
            People
          </h3>
          <p className={styles.planFor} data-reveal="1">
            For anyone reading a report in the browser.
          </p>
          <p className={styles.planIncludes} data-reveal="2">
            Every report, every flag and its evidence. Rate limited, no wallet needed.
          </p>
          <div className={styles.planFoot} data-reveal="3">
            <p className={styles.price}>Free</p>
            <Link href="/#assay" className="btn btn--ink">
              Assay an address
            </Link>
          </div>
        </div>
        <div className={styles.plan} style={{ background: "var(--accent)" }}>
          <h3 className={styles.planName} data-reveal="0">
            Agents
          </h3>
          <p className={styles.planFor} data-reveal="1">
            For agents that check a seller before paying it.
          </p>
          <p className={styles.planIncludes} data-reveal="2">
            Paid over x402 in USA₮, USDC or USDT on Celo. A check returns pass, caution or block with a signed
            score. The full report with evidence and an attestation is $0.01.
          </p>
          <div className={styles.planFoot} data-reveal="3">
            <p className={styles.price}>
              $0.002<span className={styles.per}> per check</span>
            </p>
            <Link href="/docs#api" className="btn btn--ink">
              Read the API
            </Link>
          </div>
        </div>
      </section>

      <section className={styles.close} aria-labelledby="close-h">
        <div className={styles.closeFlank}>
          <Image
            src="/img/old-u-s-assay-office-1.jpg"
            alt="The Old U.S. Assay Office in Boise, Idaho, a sandstone building with a hipped roof"
            width={1920}
            height={1280}
            sizes="25vw"
          />
        </div>
        <div className={styles.closeTile} data-reveal="1">
          <h2 id="close-h" className={styles.closeHead}>
            Test your own revenue
          </h2>
          <p className={styles.closeLine}>
            Paste your seller address. If it assays well, publish the hallmark where any contract can read it.
          </p>
          <AddressForm tone="accent" />
        </div>
        <div className={styles.closeFlank}>
          <Image
            src="/img/case-assay-set.jpg"
            alt="A museum assay set: a wooden case of glass reagent bottles with a small balance"
            width={1920}
            height={1440}
            sizes="25vw"
          />
        </div>
      </section>

      <Footer />
    </>
  );
}
