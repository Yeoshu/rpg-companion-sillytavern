/**
 * Links item definitions to the tracker inventory by name.
 *
 * Inventory entries are free text written by the AI or the user: "Health
 * Potion x3", "3x Health Potions", "2 Bombs", "Rope (50 ft)". An item
 * definition called "Health Potion" matches any entry whose name, without the
 * count and a trailing plural "s", is the same (case-insensitive).
 *
 * Pure module: works on arrays of entry strings.
 */

const COUNT_PATTERNS = [
    /^(.*?)\s*[x×]\s*(\d+)\s*$/i,          // Name x3, Name ×3
    /^(.*?)\s*\(\s*[x×]?\s*(\d+)\s*\)\s*$/i, // Name (3), Name (x3)
    /^(\d+)\s*[x×]?\s+(.*)$/i               // 3 Name, 3x Name
];

function clean(text) {
    return String(text ?? '').replace(/[*_`~]/g, '').trim();
}

function nameKey(name) {
    return clean(name).toLowerCase().replace(/\s+/g, ' ');
}

/** Same name, allowing a plural "s"/"es" on either side. */
function sameName(a, b) {
    if (!a || !b) return false;
    return a === b || a + 's' === b || b + 's' === a || a + 'es' === b || b + 'es' === a;
}

/**
 * Splits an inventory entry into a name and count (1 when no count is written).
 * @returns {{ name: string, quantity: number }}
 */
export function parseEntry(entry) {
    const text = clean(entry);
    for (const [i, re] of COUNT_PATTERNS.entries()) {
        const m = text.match(re);
        if (!m) continue;
        const [name, count] = i === 2 ? [m[2], m[1]] : [m[1], m[2]];
        if (name.trim()) return { name: name.trim(), quantity: Number(count) };
    }
    return { name: text, quantity: 1 };
}

/** Index of the entry for an item, or -1. */
export function findEntry(entries, itemName) {
    const key = nameKey(itemName);
    if (!key) return -1;
    return (entries || []).findIndex(entry => sameName(nameKey(parseEntry(entry).name), key));
}

/** How many of an item the inventory holds, or null when it isn't there. */
export function inventoryQuantity(entries, itemName) {
    const i = findEntry(entries, itemName);
    return i < 0 ? null : parseEntry(entries[i]).quantity;
}

/**
 * Returns a new entry list with the item's count set. 0 removes the entry;
 * a missing item is appended. The entry keeps its original name spelling.
 */
export function setInventoryQuantity(entries, itemName, quantity) {
    const list = [...(entries || [])];
    const i = findEntry(list, itemName);
    const n = Math.max(0, Math.floor(Number(quantity) || 0));
    const name = i >= 0 ? parseEntry(list[i]).name : clean(itemName);
    const text = n === 1 ? name : `${name} x${n}`;
    if (n === 0) {
        if (i >= 0) list.splice(i, 1);
    } else if (i >= 0) {
        list[i] = text;
    } else {
        list.push(text);
    }
    return list;
}
