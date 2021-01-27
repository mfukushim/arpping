'use strict';

const os = require('os');
const { exec } = require('child_process');

const macLookup = require('./macLookup.js');

var flag,
  ipCommand,
  osType = os.type();

switch(osType) {
    case 'Windows_NT':
        flag = '-w';
        ipCommand = 'chcp 65001&&ipconfig /all';
        break;
    case 'Linux':
        flag = '-w';
        ipCommand = 'ifconfig';
        break;
    case 'Darwin':
        flag = '-t';
        ipCommand = 'ifconfig';
        break;
    default:
        throw new Error(`Unsupported OS: ${osType}`);
}

function Arpping({ timeout = 5, includeEndpoints = false, useCache = true, cacheTimeout = 3600 } = {}) {
    if (timeout < 1 || timeout > 60) throw new Error(`Invalid timeout parameter: ${timeout}. Timeout should be between 1 and 60.`);
    this.timeout = parseInt(timeout) || timeout.toFixed(0);

    this.includeEndpoints = includeEndpoints;
    this.myIP = null;

    this.useCache = useCache;
    this.cache = [];
    this.cacheTimeout = cacheTimeout;
    this.cacheUpdate = 0;
}

/**
 * Build array of full ip range (xxx.xxx.x.1-255) given example ip address
 * @param {String} ip
 */
Arpping.prototype._getFullRange = function(ip) {
    // don't use default assignment so false-y values are overwritten
    ip = ip || this.myIP;
    var ipStart = ip.substr(0, ip.lastIndexOf('.') + 1);
    return this.includeEndpoints ?
      Array.from({ length: 255 }, (_, i) => ipStart + (i + 1)):
      Array.from({ length: 253 }, (_, i) => ipStart + (i + 2));
}

/**
 * Find ip and mac addresses of host device
 */
Arpping.prototype.findMyInfo = function() {
    return new Promise((resolve, reject) => {
        exec(ipCommand, (err, stdout, stderr) => {
            if (err) return reject(err);

            var output = null;
            var ip = null;
            var mac = null;
            if (osType == 'Linux') {
                //  TODO: It is better to set the target netmask,broadcast,etc by args. Assume eth0
                let n = stdout.split('\n\n').filter(io => io.includes("inet")
                  && io.includes("netmask 255.255.255.0")
                  && io.trim().includes("eth0:"));
                if (n && n.length > 0) {
                    let m = n[0].match(/inet ([^/s]+?) /)
                    ip = m ? m[1] : ""
                    let p = n[0].match(/ether ([^/s].+?) /)
                    mac = p ? p[1] : ""
                } else {
                    return reject(new Error('No interface'));
                }
            } else if(osType == 'Windows_NT') {
                ip = stdout.slice(stdout.indexOf('IPv4 Address'), stdout.indexOf('Subnet Mask')).trim();
                ip = ip.slice(ip.indexOf(':')+1, ip.indexOf('(Preferred)')).trim();
                mac = stdout.slice(stdout.indexOf('Physical Address'),stdout.indexOf('DHCP Enabled')).trim();
                mac = mac.slice(mac.indexOf(':')+1).trim();
            }
            else {
                output = stdout.slice(stdout.indexOf('en0'));
                output = output.slice(0, output.indexOf('active\n')) + 'active';
                if (output.split('status: ')[1] == 'inactive') return reject(new Error('No wifi connection'));
                ip = output.slice(output.indexOf('IPv4 Address ') + 5, output.indexOf('Subnet Mask')).trim();
                mac = output.slice(output.indexOf('ether ')).split('\n')[0].split(' ')[1].trim().replaceAll('-',':');
            }
            var type = macLookup(mac);

            this.myIP = ip;
            return resolve(type ? { ip, mac, type }: { ip, mac });
        });
    });
}

/**
 * Discover all hosts connected to your local network or based on a reference IP address
 * @param {String} refIP
 * @param {Boolean} retry
 */
Arpping.prototype.discover = function(refIP, retry = true) {
    if (this.useCache && this.cache.length && Date.now() - this.cacheUpdate < this.cacheTimeout * 1000) {
        return new Promise((resolve, reject) => resolve(this.cache));
    }
    if (!refIP && !this.myIP) {
        if (retry) return this.findMyInfo().then(info => this.discover(info.ip, false));
        return new Promise((resolve, reject) => reject(new Error('Failed to find host IP address')));
    }
    var range = this._getFullRange(refIP);
    return this.ping(range).then(({ hosts }) => this.arp(hosts)).then(({ hosts }) => {
        this.cache = hosts.slice(0);
        this.cacheUpdate = Date.now();
        return hosts;
    });
}

/**
 * Ping a range of ip addresses
 * @param {Array} range
 */
Arpping.prototype.ping = function(range) {
    if (!(Array.isArray(range) && range.length)) {
        if (!this.myIP) return this.findMyInfo().then(() => this.ping(range));
        range = this._getFullRange();
    }

    return new Promise((resolve, reject) => {
        var hosts = [],
          missing =[],
          checked = 0;
        range.forEach(ip => {
            exec(`ping ${flag} ${this.timeout} ${ip}`, (err, stdout, stderr) => {
                checked++;
                if (err || stdout.indexOf('100% packet loss') > -1) missing.push(ip);
                else hosts.push(ip);

                if (checked == range.length) resolve({ hosts, missing });
            });
        });
    });
}

/**
 * Arp a range of ip addresses
 * @param {Array} range
 */
Arpping.prototype.arp = function(range) {
    return new Promise((resolve, reject) => {
        if (typeof range == 'string') range = [ range ];
        else if (!Array.isArray(range)) return reject(new Error('range must be an array of IP addresses'));
        else if (!range.length) return resolve({ hosts: [], missing: [] });
        //  reference https://github.com/telemansoft/arpping
        var command = (osType === 'Linux' || osType === 'Darwin') ? 'arp ' : 'arp -a ';
        var hosts = [],
          missing = [],
          checked = 0;
        range.forEach(ip => {
            exec(`${command}${ip}`, (err, stdout, stderr) => {
                checked++;
                if (err || stdout.toLowerCase().indexOf('no') > -1) missing.push(ip);
                else {
                    //  reference https://github.com/telemansoft/arpping
                    var mac = ""
                    if (osType === 'Linux') {
                        mac = stdout.split('\n')[1].replace(/ +/g, ' ').split(' ')[2];
                        mac = mac.includes(":") ? mac : ":::::"
                    } else if (osType === 'Darwin') {
                        mac = stdout.split(' ')[3];
                    } else {
                        mac = (stdout.split('\n')[3] || '').replace(/ +/g, ' ').replace(/-/g, ':').split(' ')[2];
                    }
                    var known = macLookup(mac);
                    var host = {mac,ip};
                    if (known) host.type = known;
                    if (ip == this.myIP) host.isHostDevice = true;
                    hosts.push(host);
                }

                if (checked == range.length) resolve({ hosts, missing });
            });
        });
    });
}

/**
 * Search for one or multiple IP addresses
 * @param {String/Array} ipArray
 * @param {String} refIP
 */
Arpping.prototype.searchByIpAddress = function(ipArray, refIP) {
    if (typeof ipArray === 'string') ipArray = [ ipArray ];
    else if (!Array.isArray(ipArray) || !ipArray.length) {
        return new Promise((resolve, reject) => reject(new Error(`Invalid ipArray: ${ipArray}. Search input should be one ip address string or an array of ip strings.`)));
    }

    return this.discover(refIP || ipArray[0]).then(hosts => {
        var hostIPs = hosts.map(h => h.ip);
        return {
            hosts: hosts.filter(h => ipArray.includes(h.ip)),
            missing: ipArray.filter(ip => !hostIPs.includes(ip))
        }
    });
}

/**
 * Search for one or multiple, full or partial mac addresses
 * @param {String/Array} macArray
 * @param {String} refIP
 */
Arpping.prototype.searchByMacAddress = function(macArray, refIP) {
    if (typeof macArray == 'string') macArray = [ macArray ];
    else if (!Array.isArray(macArray) || !macArray.length) {
        return new Promise((resolve, reject) => reject(`Invalid macArray: ${macArray}. Search input should be one mac address string or an array of mac address strings.`));
    }

    return this.discover(refIP).then(hosts => {
        var check = JSON.stringify(hosts);
        return {
            hosts: hosts.filter(h => {
                h.matched = [];
                for (var m of macArray) if (h.mac.toLowerCase().indexOf(m.toLowerCase()) > -1) h.matched.push(m);
                return h.matched.length;
            }),
            missing: macArray.filter(m => check.indexOf(m) == -1)
        }
    });
}

/**
 * Search for devices with the designated mac address type
 * @param {String} macType
 * @param {String} refIP
 */
Arpping.prototype.searchByMacType = function(macType, refIP) {
    macType = macType.toLowerCase();
    return this.discover(refIP).then(hosts => hosts.filter(h => h.type && h.type.toLowerCase() == macType));
}

module.exports = Arpping;
