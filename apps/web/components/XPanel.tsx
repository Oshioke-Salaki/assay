import type { XMentions, XPost } from "@/lib/api";
import { date, txUrl } from "@/lib/format";
import { ago, compact } from "@/lib/x";
import styles from "./app.module.css";
import x from "./x.module.css";

const SHOWN = 4;

/**
 * What X says about an address: the posts that name it, warning words first, each linked. Shown as
 * evidence beside the score, never in it, and the panel says so.
 */
export function XPanel({
  mentions,
  address,
  isSeller,
}: {
  mentions: XMentions | null | undefined;
  address: string;
  isSeller: boolean;
}) {
  const search = `https://x.com/search?q=${encodeURIComponent(`"${address}"`)}&f=live`;
  return (
    <div className={x.wrap}>
      <Summary m={mentions} isSeller={isSeller} />
      {mentions?.status === "ok" && mentions.posts.length > 0 ? (
        <>
          <ol className={x.posts}>
            {mentions.posts.slice(0, SHOWN).map((p) => (
              <Post key={p.id} p={p} />
            ))}
          </ol>
          {mentions.posts.length > SHOWN ? (
            <details className={x.more}>
              <summary>
                Show {mentions.posts.length - SHOWN} more post{mentions.posts.length - SHOWN === 1 ? "" : "s"}
              </summary>
              <ol className={x.posts}>
                {mentions.posts.slice(SHOWN).map((p) => (
                  <Post key={p.id} p={p} />
                ))}
              </ol>
            </details>
          ) : null}
        </>
      ) : null}
      <p className={x.foot}>
        Evidence, not part of the score: anyone can post about any address, so posts never move a rating.{" "}
        <a className="link" href={mentions?.searchUrl ?? search} target="_blank" rel="noreferrer">
          Search X yourself
        </a>
        {mentions?.tx ? (
          <>
            {" · "}
            <a className="link" href={txUrl(mentions.tx)} target="_blank" rel="noreferrer">
              this search was paid for through buy
            </a>
          </>
        ) : null}
        .
      </p>
    </div>
  );
}

function Summary({ m, isSeller }: { m: XMentions | null | undefined; isSeller: boolean }) {
  if (m === undefined) return <p className={styles.empty}>This Assay server does not search X yet.</p>;
  if (m === null)
    return (
      <p className={styles.empty}>
        {isSeller
          ? "Not searched yet. It is queued: Assay searches X for every seller and re-checks each one weekly."
          : "Not searched. Assay searches X for sellers, and for any address an agent pays to check."}
      </p>
    );
  if (m.status === "error")
    return (
      <p className={styles.empty}>
        The last search, {ago(m.checkedAt)}, did not complete. It is retried within a day.
      </p>
    );
  if (m.mentions === 0)
    return (
      <p className={x.lead}>
        <strong>Nobody on X has posted this address.</strong>{" "}
        <span className={styles.muted}>Searched {ago(m.checkedAt)}.</span>
      </p>
    );
  return (
    <p className={x.lead}>
      <strong>
        {m.mentions} post{m.mentions === 1 ? "" : "s"} name this address
      </strong>
      {m.warnings > 0 ? (
        <>
          {"; "}
          <span className={x.bad}>{m.warnings} next to words like scam or hack</span>
        </>
      ) : null}
      {m.weakWarnings > 0 ? (
        <span className={styles.muted}>
          {m.warnings > 0 ? ", plus " : "; "}
          {m.weakWarnings} such post{m.weakWarnings === 1 ? "" : "s"} from new or small accounts
        </span>
      ) : null}
      . <span className={styles.muted}>Searched {ago(m.checkedAt)}.</span>
    </p>
  );
}

function Post({ p }: { p: XPost }) {
  const strong = p.warning && !p.weak && !p.copy;
  return (
    <li className={`${x.post} ${strong ? x.postBad : ""}`}>
      <div className={x.meta}>
        <a
          className={x.author}
          href={`https://x.com/${encodeURIComponent(p.author)}`}
          target="_blank"
          rel="noreferrer"
        >
          @{p.author}
        </a>
        {p.verified ? (
          <span className={x.tick} title="Verified on X">
            ✓<span className="sr-only"> verified</span>
          </span>
        ) : null}
        <span className={styles.muted}>{compact(p.followers)} followers</span>
        {p.postedAt ? <span className={styles.muted}>{date(p.postedAt)}</span> : null}
        {p.copy ? (
          <span className={styles.pill}>Same text as a post above</span>
        ) : p.warning ? (
          <span className={`${styles.pill} ${p.weak ? styles.pillWarn : styles.pillBad}`}>
            {p.weak ? "Warning words · new or small account" : "Warning words"}
          </span>
        ) : null}
      </div>
      <p className={x.text}>{p.excerpt ?? p.text}</p>
      <a className={`link ${x.open}`} href={p.url} target="_blank" rel="noreferrer">
        Open the full post on X
      </a>
    </li>
  );
}
