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
        ipCommand = 'ipconfig';
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
        throw new Error('Unsupported OS: ' + osType);
}

var arpping = {
    /**
    * Build array of full ip range (xxx.xxx.x.1-255) given example ip address
    * @param {String} ip
    * @returns {Array}
    */
    _getFullRange: function(ip) {
        ip = ip || arpping.myIP;
        var ipStart = ip.substr(0, ip.lastIndexOf('.') + 1);
        return arpping.includeEndpoints ? 
            Array.from({ length: 255 }, (el, i) => ipStart + (i + 1)):
            Array.from({ length: 253 }, (el, i) => ipStart + (i + 2));
    },
    /**
    * Find ip and mac addresses of host device
    * @param {Function} callback
    */
    findMyInfo: function(callback) {
        exec(ipCommand, (err, stdout, stderr) => {
            if (err) {
                console.log(err);
                return callback(err);
            }
            if (osType == 'Linux') {
                if (stdout.indexOf('wlan0') == -1) return callback(new Error('No wifi connection'));
                var wlan0 = stdout.split('wlan0')[1].split('\n');
                var ip = wlan0[1].slice(wlan0[1].indexOf('inet ')).split(' ')[1];
                var mac = wlan0[3].slice(wlan0[3].indexOf('ether ')).split(' ')[1];
            }
            else {
                var en0 = stdout.slice(stdout.indexOf('en0')).split('status: ');
                if (en0[1].split(' ')[0] == 'inactive') return callback(new Error('No wifi connection'));
                en0 = en0[0].split('\n\t');
                var ip = en0.find(el => el.indexOf('inet ') > -1).split(' ')[1];
                var mac = en0.find(el => el.indexOf('ether ') > -1).split(' ')[1];
            }

            arpping.myIP = ip;
            callback(null, { ip, mac });
        });
    },
    /**
    * Discover all hosts connected to your local network or based on a reference IP address
    * @param {String} refIP
    * @param {Function} callback
    * @param {Boolean} retry
    */
    discover: function(refIP, callback, retry) {
        if (arpping.useCache && arpping.cachedDevices.length) return callback(null, arpping.cachedDevices)
        if (!refIP && !arpping.myIP) {
            if (retry) return callback(new Error('Failed to find your IP address'));
            return arpping.findMyInfo((err, info) => {
                if (err) return callback(err);
                arpping.discover(info.ip, callback, true);
            });
        }
        var range = arpping._getFullRange(refIP || arpping.myIP);
        arpping.ping(range, (err, hosts) => {
            if (err) return callback(err);
            if (!hosts.length) return callback(null, []);
            arpping.arp(hosts, (error, hosts) => {
                if (error) return callback(error);
                arpping.cachedDevices = hosts;
                callback(null, hosts);
            });
        });
    },
    search: {
        /**
        * Search for one or multiple IP addresses
        * @param {String/Array} ipArray
        * @param {String} refIP
        * @param {Function} callback
        */
        byIpAddress: function(ipArray, refIP, callback) {
            if (typeof ipArray == 'string') ipArray = [ ipArray ];
            else if (!Array.isArray(ipArray) || !ipArray.length) {
                throw new Error(
                    `Invalid ipArray: ${ipArray}. 
                    Search input should be one ip address string or an array of ip strings.`
                );
            }
            
            arpping.discover(refIP || ipArray[0], (err, hosts) => {
                if (err) return callback(err);
                callback(
                    null,
                    hosts.filter(h => ipArray.includes(h.ip)),
                    ipArray.filter(ip => !hosts.map(h => h.ip).includes(ip))
                );
            });
        },
        /**
        * Search for one or multiple, full or partial mac addresses
        * @param {String/Array} macArray
        * @param {String} refIP
        * @param {Function} callback
        */
        byMacAddress: function(macArray, refIP, callback) {
            if (typeof macArray == 'string') macArray = [ macArray ];
            else if (!Array.isArray(macArray) || !macArray.length) {
                throw new Error(
                    `Invalid macArray: ${macArray}. 
                    Search input should be one mac address string or an array of mac address strings.`
                );
            }
            
            arpping.discover(refIP, (err, hosts) => {
                if (err) return callback(err);
                var check = JSON.stringify(hosts);
                callback(
                    null,
                    hosts.filter(h => {
                        h.matched = [];
                        for (var m of macArray) if (h.mac.indexOf(m) > -1) h.matched.push(m);
                        return h.matched.length;
                    }),
                    macArray.filter(m => check.indexOf(m) == -1)
                );
            })
        },
        /**
        * Search for devices with the designated mac address type
        * @param {String} macType
        * @param {String} refIP
        * @param {Function} callback
        */
        byMacType: function(macType, refIP, callback) {
            arpping.discover(refIP, (err, hosts) => {
                if (err) return callback(err);
                callback(null, hosts.filter(h => h.type == macType));
            });
        }
    },
    /**
    * Ping a range of ip addresses
    * @param {Array/String} range
    * @param {Function} callback
    */
    ping: function(range, callback) {
        if (typeof range == 'string') range = [ range ];
        if (!(Array.isArray(range) && range.length)) {
            if (!arpping.myIP) return arpping.findMyInfo(() => arpping.ping(range, callback));
            range = arpping._getFullRange();
        }
        
        var found = [],
            missing =[],
            checked = 0;
        
        range.forEach((ip) => {
            exec(`ping ${flag} ${arpping.timeout} ${ip}`, (err, stdout, stderr) => {
                checked++;
                if (err || stdout.indexOf('100% packet loss') > -1) missing.push(ip);
                else found.push(ip);
                
                if (checked == range.length) callback(null, found, missing);
            });
        });
    },
    /**
    * Arp a range of ip addresses
    * @param {Array/String} range
    * @param {Function} callback
    */
    arp: function(range, callback) {
        if (typeof range == 'string') range = [ range ];
        if (!Array.isArray(range)) return callback(new Error('range must be an array of IP addresses'));
        if (!range.length) return callback(new Error('range must not be empty'));
        
        var hosts = [],
            missing = [],
            checked = 0;
        
        range.forEach(ip => {
            exec(`arp ${ip}`, (err, stdout, stderr) => {
                checked++;
                if (err || stdout.indexOf('no entry') > -1) missing.push(ip);
                else {
                    var mac = (osType == 'Linux') ? 
                        stdout.split('\n')[1].replace(/ +/g, ' ').split(' ')[2]: 
                        stdout.split(' ')[3];
                    hosts.push({
                        ip, mac,
                        type: macLookup(mac),
                        isYourDevice: ip == arpping.myIP
                    });
                }
                
                if (checked == range.length) callback(null, hosts, missing);
            });
        });
    },
    myIP: null,
    timeout: 5,
    includeEndpoints: false,
    useCache: true,
    cachedDevices: []
}


module.exports = function(options) {
    if (options.hasOwnProperty('timeout')) {
        if (options.timeout < 1 || options.timeout > 60) throw new Error(`Invalid timeout: ${options.timeout}. Please choose a timeout between 1 and 60s`);
        else arpping.timeout = parseInt(options.timeout) || options.timeout.toFixed(0);
    }
    
    arpping.includeEndpoints = !!options.includeEndpoints;
    
    return arpping;
};