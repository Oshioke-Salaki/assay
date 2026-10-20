import type { Address, PairFlow } from "./types.js";

/**
 * The x402 payment graph: who paid whom, aggregated per (payer, payee) pair,
 * with strongly connected components precomputed. A component of size > 1 is a
 * set of addresses where money can travel from any member back to itself.
 */
export class Ledger {
  readonly outgoing = new Map<Address, Map<Address, PairFlow>>();
  readonly incoming = new Map<Address, Map<Address, PairFlow>>();
  private readonly componentOf = new Map<Address, number>();
  private readonly components: Address[][] = [];

  constructor(flows: Iterable<PairFlow>) {
    for (const flow of flows) {
      if (flow.payer === flow.payee) continue;
      setFlow(this.outgoing, flow.payer, flow.payee, flow);
      setFlow(this.incoming, flow.payee, flow.payer, flow);
    }
    this.computeComponents();
  }

  get nodes(): Address[] {
    const all = new Set<Address>([...this.outgoing.keys(), ...this.incoming.keys()]);
    return [...all];
  }

  payersOf(address: Address): PairFlow[] {
    return [...(this.incoming.get(address)?.values() ?? [])];
  }

  payeesOf(address: Address): PairFlow[] {
    return [...(this.outgoing.get(address)?.values() ?? [])];
  }

  /** Members of the address's strongly connected component, itself included. */
  componentMembers(address: Address): Address[] {
    const id = this.componentOf.get(address);
    return id === undefined ? [address] : (this.components[id] ?? [address]);
  }

  sameComponent(a: Address, b: Address): boolean {
    const ca = this.componentOf.get(a);
    return ca !== undefined && ca === this.componentOf.get(b);
  }

  /** Components with more than one member, largest first. */
  loops(): Address[][] {
    return this.components.filter((c) => c.length > 1).sort((x, y) => y.length - x.length);
  }

  /** Iterative Tarjan, so a long payment chain cannot overflow the stack. */
  private computeComponents(): void {
    const index = new Map<Address, number>();
    const low = new Map<Address, number>();
    const onStack = new Set<Address>();
    const stack: Address[] = [];
    let counter = 0;

    for (const root of this.nodes) {
      if (index.has(root)) continue;
      const work: { node: Address; edges: Address[]; next: number }[] = [];
      const enter = (node: Address) => {
        index.set(node, counter);
        low.set(node, counter);
        counter++;
        stack.push(node);
        onStack.add(node);
        work.push({ node, edges: [...(this.outgoing.get(node)?.keys() ?? [])], next: 0 });
      };
      enter(root);

      while (work.length > 0) {
        const frame = work[work.length - 1]!;
        if (frame.next < frame.edges.length) {
          const target = frame.edges[frame.next++]!;
          if (!index.has(target)) {
            enter(target);
          } else if (onStack.has(target)) {
            low.set(frame.node, Math.min(low.get(frame.node)!, index.get(target)!));
          }
          continue;
        }
        work.pop();
        const parent = work[work.length - 1];
        if (parent) low.set(parent.node, Math.min(low.get(parent.node)!, low.get(frame.node)!));
        if (low.get(frame.node) === index.get(frame.node)) {
          const component: Address[] = [];
          let member: Address;
          do {
            member = stack.pop()!;
            onStack.delete(member);
            component.push(member);
          } while (member !== frame.node);
          const id = this.components.length;
          this.components.push(component);
          for (const m of component) this.componentOf.set(m, id);
        }
      }
    }
  }
}

function setFlow(
  map: Map<Address, Map<Address, PairFlow>>,
  key: Address,
  other: Address,
  flow: PairFlow,
): void {
  let inner = map.get(key);
  if (!inner) {
    inner = new Map();
    map.set(key, inner);
  }
  const existing = inner.get(other);
  inner.set(other, existing ? mergeFlows(existing, flow) : flow);
}

/** Combine two aggregates of the same pair (e.g. from different tokens). */
export function mergeFlows(a: PairFlow, b: PairFlow): PairFlow {
  const days = [...new Set([...a.days, ...b.days])].sort((x, y) => x - y);
  const sampleTxs = [...new Set([...a.sampleTxs, ...b.sampleTxs])].slice(0, 5);
  return {
    payer: a.payer,
    payee: a.payee,
    count: a.count + b.count,
    usd: a.usd + b.usd,
    firstTs: Math.min(a.firstTs, b.firstTs),
    lastTs: Math.max(a.lastTs, b.lastTs),
    days,
    sampleTxs,
  };
}
