/** Stable integration boundary. Runtime inputs must be validated by their owner. */
export type Mode = 'live' | 'simulation';
export interface Relation { subject: string; predicate: string; object: string; observedAt: string; source: string; confidence: number; }
export interface OrganimaEvent { id: string; type: string; cellId: string; occurredAt: string; mode: Mode; payload: Record<string, unknown>; }
export interface GraphSnapshot { version: number; relations: Relation[]; events: OrganimaEvent[]; }
export interface CellDescriptor { id: string; parentId: string | null; name: string; capabilities: string[]; status: 'ready' | 'offline' | 'busy' | 'error'; mode: Mode; }
export interface Goal { id: string; cellId: string; object: string; target: string; relation: 'ON'; deadline: string; mode: Mode; }
export interface GoalStatus { goal: Goal; state: 'accepted' | 'running' | 'awaiting_verification' | 'verified' | 'failed' | 'cancelled'; reason?: string; updatedAt: string; }
export interface ResearchSource { title: string; url: string; content: string; score: number; }
export interface ResearchResult { query: string; sources: ResearchSource[]; retrievedAt: string; mode: Mode; }
export interface ProviderStatus { name: string; configured: boolean; model?: string; state: 'unconfigured' | 'untested' | 'ready' | 'error' | 'simulation'; detail?: string; }
export interface AttentionDecision { notify: boolean; research: boolean; escalate: boolean; probability: number; probabilities?: {notify:number;research:number;escalate:number}; threshold?: number; researchOverride?: 'explicit-web-request'; provider: 'jev' | 'nvidia' | 'rules'; mode: Mode; }
export interface ChatReply { text: string; mode: Mode; sources: ResearchSource[]; decision: AttentionDecision; model: string; }
export interface MemoryPort {
 append(event: OrganimaEvent): Promise<boolean>;
 snapshot(): GraphSnapshot;
 context(cellId: string): OrganimaEvent[];
 setContext(cellId: string, events: OrganimaEvent[]): void;
 query(term: string): {relations: Relation[]; events: OrganimaEvent[]};
}
export interface CognitionPort {
 statuses(): ProviderStatus[];
 decide(state: string): Promise<AttentionDecision>;
 research(query: string): Promise<ResearchResult>;
 reply(message: string, snapshot: GraphSnapshot, history: OrganimaEvent[]): Promise<ChatReply>;
 observe(imageDataUrl: string): Promise<Relation[]>;
}
export interface RobotPort {
 describe(): CellDescriptor;
 submit(goal: Goal): GoalStatus;
 tick(now?: number): GoalStatus | null;
 cancel(reason?: string): GoalStatus | null;
 verify(relations: Relation[], source: string): GoalStatus | null;
 status(): GoalStatus | null;
}
