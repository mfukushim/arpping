const hexToNetmask = hex => {
    if (hex.indexOf('0x') != 0) return hex;

    const match = /([0-f]+)/i.exec(hex);
    if (!match) return hex;

    const matchText = parseInt(match[1], 16);
    return ((matchText >> 24) & 0xff) + '.' + ((matchText >> 16) & 0xff) + '.' + ((matchText >> 8) & 0xff) + '.' + (matchText & 0xff);
}

module.exports = { hexToNetmask }