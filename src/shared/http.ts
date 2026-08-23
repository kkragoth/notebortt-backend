import type { Response } from 'express';

export function toRecord<T extends { id: string }>(rows: T[]): Record<string, T> {
    return Object.fromEntries(rows.map((row) => [row.id, row]));
}

export function getRequiredString(value: unknown): string | null {
    if (typeof value !== 'string') {
        return null;
    }

    const trimmed = value.trim();
    return trimmed ? trimmed : null;
}

export function getBoardPermission(value: unknown): 'view' | 'edit' | null {
    if (value === 'view' || value === 'edit') {
        return value;
    }

    return null;
}

export function sendBadRequest(res: Response, error: string): void {
    res.status(400).json({ error });
}

export function sendForbidden(res: Response, error = 'Forbidden'): void {
    res.status(403).json({ error });
}

export function sendNotFound(res: Response, error: string): void {
    res.status(404).json({ error });
}
