export interface EventPayload {
 id: string;
 type: string;
 timestamp: number;
 data: Record<string, unknown>
}

