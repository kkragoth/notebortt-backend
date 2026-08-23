const USER_COLORS = [
    '#8B5CF6', '#EC4899', '#F59E0B', '#10B981',
    '#3B82F6', '#EF4444', '#6366F1', '#14B8A6',
];

export function getUserColor(userId: string): string {
    let hash = 0;
    for (let i = 0; i < userId.length; i++) {
        hash = ((hash << 5) - hash) + userId.charCodeAt(i);
        hash |= 0;
    }
    return USER_COLORS[Math.abs(hash) % USER_COLORS.length];
}
