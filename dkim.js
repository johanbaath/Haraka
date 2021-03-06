var crypto = require('crypto');
var Stream = require('stream').Stream;
var indexOfLF = require('./utils').indexOfLF;
var util = require('util');
var dns = require('dns');
var fs = require('fs');

//////////////////////
// Common functions //
//////////////////////

function Buf() {
    this.buffer = {
        bar: [],
        blen: 0,
        pop: function (buf) {
            if (!this.bar.length) {
                if (!buf) buf = new Buffer('');
                return buf;
            }
            if (buf && buf.length) {
                this.bar.push(buf);
                this.blen += buf.length;
            }
            var nb = Buffer.concat(this.bar, this.blen);
            this.bar = [];
            this.blen = 0;
            return nb;
        },
        push: function (buf) {
            if (buf.length) {
                this.bar.push(buf);
                this.blen += buf.length;
            }
        }
    };
    return this.buffer;
}

////////////////
// DKIMObject //
////////////////

// There is one DKIMObject created for each signature found

function DKIMObject(header, header_idx, cb) {
    this.cb = cb;
    this.sig = header;
    this.run_cb = false;
    this.header_idx = header_idx;
    this.fields = {};
    this.headercanon = this.bodycanon = 'simple';
    this.signed_headers = [];
    this.identity = 'unknown';
    this.line_buffer = new Buf;
    this.last2octets = new Buf(2);
    this.dns_fields = {
        'v': 'DKIM1',
        'k': 'rsa',
        'g': '*', 
    };

    var m = /^([^:]+):\s*((?:.|[\r\n])*)$/.exec(header);
    var sig = m[2].trim().replace('\s+','');
    var keys = sig.split(';');
    for (var k=0; k<keys.length; k++) {
        var key = keys[k].trim();
        if (!key) continue;  // skip empty keys
        var m;
        if ((m = /^([^= ]+)=((?:.|[\r\n])+)$/.exec(key))) {
            this.fields[m[1]] = m[2];
        }
        else {
            return this.result('header parse error', 'invalid');
        }
    }

    /////////////////////
    // Validate fields //
    /////////////////////

    if (this.fields['v']) {
        if (this.fields['v'] !== '1') {
            return this.result('incompatible version', 'invalid');
        }
    }
    else {
        return this.result('missing version', 'invalid');
    }

    if (this.fields['a']) {
        switch (this.fields['a']) {
            case 'rsa-sha1':
                this.bh = crypto.createHash('SHA1');
                this.verifier = crypto.createVerify('RSA-SHA1');
                break;
            case 'rsa-sha256':
                this.bh = crypto.createHash('SHA256');
                this.verifier = crypto.createVerify('RSA-SHA256');
                break;
            default:
                this.debug('Invalid algorithm: ' + this.fields['a']);
                return this.result('invalid algorithm', 'invalid');
        }
    }
    else {
        return this.result('missing algorithm', 'invalid');
    }

    if (!this.fields['b'])  return this.result('signature missing', 'invalid');
    if (!this.fields['bh']) return this.result('body hash missing', 'invalid');

    if (this.fields['c']) {
        var c = this.fields['c'].split('/');
        if (c[0]) this.headercanon = c[0];
        if (c[1]) this.bodycanon = c[1];
    }      
        
    if (!this.fields['d']) return this.result('domain missing', 'invalid');

    if (this.fields['h']) {
        var headers = this.fields['h'].split(':');
        for (var h=0; h<headers.length; h++) {
            var header = headers[h].trim().toLowerCase();
            this.signed_headers.push(header);
        }
        if (this.signed_headers.indexOf('from') === -1) {
            return this.result('from field not signed', 'invalid');
        }
    }
    else {
        return this.result('signed headers missing', 'invalid');
    }
    
    if (this.fields['i']) {
        // Make sure that this is a sub-domain of the 'd' field
        var dom = this.fields['i'].substr(this.fields['i'].length - this.fields['d'].length);
        if (dom !== this.fields['d']) {
            return this.result('domain mismatch', 'invalid');
        }
    }
    else {
        this.fields['i'] = '@' + this.fields['d'];
    }
    this.identity = this.fields['i'];

    if (this.fields['q'] && this.fields['q'] !== 'dns/txt') {
        return this.result('unknown query method', 'invalid');
    }

    var now = (new Date).getTime()/1000;
    if (this.fields['t']) {
        if (this.fields['t'] > now) {
            return this.result('bad creation date', 'invalid');
        }
    }
    
    if (this.fields['x']) {
        if (this.fields['t'] && parseInt(this.fields['x']) < parseInt(this.fields['t'])) {
            return this.result('invalid expiration date', 'invalid');
        }
        if (now > this.fields['x']) { 
            return this.result('signature expired', 'invalid');
        }
    }

    this.debug(this.identity + ': DKIM fields validated OK');
    this.debug([
        this.identity + ':',
        'a=' + this.fields['a'],
        'c=' + this.headercanon + '/' + this.bodycanon,
        'h=' + this.signed_headers,
    ].join(' '));
}

DKIMObject.prototype.debug = function (str) {
    util.debug(str);
}

DKIMObject.prototype.header_canon_relaxed = function (header) {
    var m;
    if ((m = /^([^:]+):\s*((?:.|[\r\n])*)$/.exec(header))) {
        hc = m[1].toLowerCase() + ':' + m[2];
        hc = hc.replace(/\r\n([\t ]+)/g, "$1");
        hc = hc.replace(/[\t ]+/g, ' ');
        hc = hc.replace(/[\t ]+(\r?\n)$/, "$1");
        return hc;
    }
    return header;
}

DKIMObject.prototype.add_body_line = function (line) {
    if (this.run_cb) return;

    // Buffer any lines
    if ((line.length === 2 && line[0] === 0x0d && line[1] === 0x0a) ||
        (line.length === 1 && line[0] === 0x0a))
    {
        // Store any empty lines as both canonicalization alogoriths
        // ignore all empty lines at the end of the message body.
        this.line_buffer.push(line);
    }
    else {
        if (this.bodycanon === 'simple') {
            var l = this.line_buffer.pop(line);
            if (l.length >= 2) {
                this.last2octets[0] = l[l.length-2];
                this.last2octets[1] = l[l.length-1];
            }
            this.bh.update(l);
        }
        else if (this.bodycanon === 'relaxed') {
            var l;
            l = this.line_buffer.pop(line).toString('binary');
            l = l.replace(/[\t ]+(\r?\n)$/,"$1");
            l = l.replace(/[\t ]+/g,' ');
            l = this.line_buffer.pop(new Buffer(l));
            this.bh.update(l);
        }
    }
}

DKIMObject.prototype.result = function (error, result) {
    this.run_cb = true;
    var self = this;
    return this.cb(
        ((error) ? new Error(error) : null), 
        {
            identity: self.identity, 
            domain: self.fields.d, 
            result: result 
        }
    );
}

DKIMObject.prototype.end = function () {
    if (this.run_cb) return;

    if (this.bodycanon === 'simple') {
        // Add CRLF if there was no body or no trailing CRLF
        if (!(this.last2octets[0] === 0x0d && this.last2octets[1] === 0x0a)) {
            //this.bh.update(new Buffer("\r\n"));
        }
    }

    var bh = this.bh.digest('base64');
    this.debug(this.identity + ':' +
               ' bodyhash=' + this.fields['bh'] +
               ' computed=' + bh);
    if (bh !== this.fields['bh']) {
        return this.result('body hash did not verify', 'fail');
    }

    // Now we canonicalize the specified headers
    for (var h=0; h<this.signed_headers.length; h++) {
        var header = this.signed_headers[h];
        this.debug(this.identity + ': canonicalize header: ' + header);
        if (this.header_idx[header]) {
            for (var i=0; i<this.header_idx[header].length; i++) {
                // Skip this signature if dkim-signature is specified
                if (header === 'dkim-signature' && this.header_idx[header][i] == this.sig) {
                    this.debug(this.identity + ': skipped our own DKIM-Signature');
                    continue;
                }
                if (this.headercanon === 'simple') {
                    this.verifier.update(this.header_idx[header][i]);
                }
                else if (this.headercanon === 'relaxed') {
                    var hc = this.header_canon_relaxed(this.header_idx[header][i]);
                    this.verifier.update(hc);
                }
            }
        }
    }

    // Now add in our original DKIM-Signature header without the b= and trailing CRLF
    var our_sig = this.sig.replace(/b=([^;]+)/,'b=');
    if (this.headercanon === 'relaxed') {
        our_sig = this.header_canon_relaxed(our_sig);
    }
    our_sig = our_sig.replace(/\r\n$/,'');
    this.verifier.update(our_sig);

    // Do the DNS lookup to retrieve the public key
    var self = this;
    var lookup = this.fields['s'] + '._domainkey.' + this.fields['d'];
    this.debug(this.identity + ': DNS lookup ' + lookup);
    dns.resolveTxt(lookup, function (err, res) {
        if (err) { 
            switch (err.code) {
                case 'ENOTFOUND':
                case 'ENODATA':
                case dns.NXDOMAIN:
                    return self.result('no key for signature', 'invalid');
                    break;
                default:
                    return self.result('key unavailable', 'tempfail');
                    break;
            }
        }
        if (!res) return self.result('no key for signature', 'invalid');
        for (var r=0; r<res.length; r++) {
            var record = res[r];
            if (record.indexOf('p=') === -1) {
                self.debug(self.identity + ': ignoring TXT record: ' + record);
                continue;
            }
            self.debug(self.identity + ': got DNS record: ' + record);
            var rec = record.replace(/\r?\n/g, '').replace(/\s+/g,'');
            var split = rec.split(';');
            for (var i=0; i<split.length; i++) {
                var split2 = split[i].split('=');
                if (split2[0]) self.dns_fields[split2[0]] = split2[1];
            }
     
            // Validate
            if (!self.dns_fields.v || self.dns_fields.v !== 'DKIM1') {
                return self.result('invalid version', 'invalid');
            }
            if (self.dns_fields.g) {
               if (self.dns_fields.g !== '*') {
                    var r = self.dns_fields.g;
                    // Escape any special regexp characters
                    r = r.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
                    // Make * a non-greedy match against anything except @
                    r = r.replace('\\*','[^@]*?');
                    var reg = new RegExp('^' + r + '@');
                    self.debug(self.identity + ': matching ' + self.dns_fields.g + 
                                      ' against i=' + self.fields.i + ' regexp=' + reg.toString());
                    if (!reg.test(self.fields.i)) {
                        return self.result('inapplicable key', 'invalid');
                    }
                }
            }
            else {
                return self.result('inapplicable key', 'invalid');
            }
            if (self.dns_fields.h) {
               var hashes = self.dns_fields['h'].split(':');
               for (var h=0; h<hashes.length; h++) {
                   var hash = hashes[h].trim();
                   if (self.fields.a.indexOf(hash) === -1) {
                       return self.result('inappropriate hash algorithm', 'invalid');
                   }
               }
            }
            if (self.dns_fields.k) {
                if (self.fields.a.indexOf(self.dns_fields.k) === -1) {
                    return self.result('inappropriate key type', 'invalid');
                }
            }
            if (self.dns_fields.t) {
                var flags = self.dns_fields.t.split(':');
                for (var f=0; f<flags.length; f++) {
                    var flag = flags[f].trim();
                    if (flag === 'y') {
                        // Test mode
                        self.test_mode = true;
                    }
                    else if (flag === 's') {
                        // 'i' and 'd' domain much match exactly
                        var i = self.fields.i;
                        i = i.substr(i.indexOf('@')+1, i.length);
                        if (i !== self.fields.d) {
                            return self.result('domain mismatch', 'invalid');
                        }
                    }
                }
            }
            if (!self.dns_fields.p) return self.result('key revoked', 'invalid');

            // crypto.verifier requires the key in PEM format
            self.public_key = '-----BEGIN PUBLIC KEY-----\r\n' +
                              self.dns_fields.p.replace(/(.{1,76})/g, '$1\r\n') +
                              '-----END PUBLIC KEY-----\r\n';

            try {
                var verified = self.verifier.verify(self.public_key, self.fields['b'], 'base64');
                self.debug(self.identity + ': verified=' + verified);
            }
            catch (e) {
                self.debug(self.identity + ': verification error: ' + e.message);
                return self.result('verification error', 'invalid');
            }
            return self.result(null, ((verified) ? 'pass' : 'fail')); 
        }
    }); 
}

exports.DKIMObject = DKIMObject;

//////////////////////
// DKIMVerifyStream //
//////////////////////

function DKIMVerifyStream(cb) {
    Stream.call(this);
    this.run_cb = false;
    var self = this;
    this.cb = function (err, result, results) {
        if (!self.run_cb) {
            self.run_cb = true;
            return cb(err, result, results);
        }
    };
    this._in_body = false;
    this._no_signatures_found = false;
    this.buffer = new Buf;
    this.headers = [];
    this.header_idx = {};
    this.dkim_objects = [];
    this.results = [];
    this.result = 'none';
    this.pending = 0;
    this.writable = true;
}

util.inherits(DKIMVerifyStream, Stream);

DKIMVerifyStream.prototype.debug = function (str) {
    util.debug(str);
}

DKIMVerifyStream.prototype.handle_buf = function (buf) {
    // Abort any further processing if the headers
    // did not contain any DKIM-Signature fields.
    if (this._in_body && this._no_signatures_found) {
        return true;
    }

    buf = this.buffer.pop(buf);

    // Process input buffer into lines
    var offset = 0;
    while ((offset = indexOfLF(buf)) !== -1) {
        var line = buf.slice(0, offset+1);
        if (buf.length > offset) {
            buf = buf.slice(offset+1);
        }

        // Check for LF line endings and convert to CRLF if necessary
        if (line[line.length-2] !== 0x0d) {
            line = Buffer.concat([ line.slice(0, line.length-1), new Buffer("\r\n") ], line.length+1);
        }
        
        // Look for CRLF
        if (line.length === 2 && line[0] === 0x0d && line[1] === 0x0a) {
            // Look for end of headers marker
            if (!this._in_body) {
                this._in_body = true;
                // Parse the headers
                for (var h=0; h<this.headers.length; h++) {
                    var header;
                    if ((header = /^([^: ]+):\s*((:?.|[\r\n])*)/.exec(this.headers[h]))) {
                        var hn = header[1].toLowerCase();
                        if (!this.header_idx[hn]) this.header_idx[hn] = [];
                        this.header_idx[hn].push(this.headers[h]);
                    }
                }
                if (!this.header_idx['dkim-signature']) {
                    this._no_signatures_found = true;
                    return this.cb(null, this.result);
                }
                else {
                    // Create new DKIM objects for each header
                    var dkim_headers = this.header_idx['dkim-signature'];
                    this.debug('Found ' + dkim_headers.length + ' DKIM signatures');
                    var self = this;
                    this.pending = dkim_headers.length;
                    for (var d=0; d<dkim_headers.length; d++) {
                        this.dkim_objects.push(new DKIMObject(dkim_headers[d], this.header_idx, function (err, result) {
                            self.pending--;
                            if (result) {
                                self.results.push({
                                    identity: result.identity,
                                    domain: result.domain,
                                    result: result.result,
                                    error: ((err) ? err.message : null)
                                });

                                // Set the overall result based on this precedence order
                                var rr = ['pass','tempfail','fail','invalid','none'];
                                for (r=0; r<rr.length; r++) {
                                    if (!self.result || (self.result && self.result !== rr[r] && result.result == rr[r])) {
                                        self.result = rr[r];
                                    }
                                }
                            }

                            self.debug(JSON.stringify(result));
                           
                            if (self.pending === 0) {
                                if (self.cb) {
                                    self.cb(null, self.result, self.results);
                                }
                            }
                        }));
                    }
                    if (this.pending === 0) {
                        if (this.cb) this.cb(new Error('no signatures found'));
                    }
                }
                continue;
            }
        }

        if (!this._in_body) {
            // Parse headers
            if (line[0] === 0x20 || line[0] === 0x09) {
                // Header continuation
                this.headers[this.headers.length-1] += line.toString('ascii');
            }
            else {
                this.headers.push(line.toString('ascii'));
            }
        }
        else {
            for (var d=0; d<this.dkim_objects.length; d++) {
                this.dkim_objects[d].add_body_line(line);
            }
        }

    }

    this.buffer.push(buf);
    return true;
}

DKIMVerifyStream.prototype.write = function(buf) {
    return this.handle_buf(buf);
}

DKIMVerifyStream.prototype.end = function(buf) {
    if (buf) this.handle_buf(buf);
    for (var d=0; d<this.dkim_objects.length; d++) {
        this.dkim_objects[d].end();
    }
    if (this.pending === 0 && this._no_signatures_found === false) this.cb(null, this.result);
}

exports.DKIMVerifyStream = DKIMVerifyStream;
