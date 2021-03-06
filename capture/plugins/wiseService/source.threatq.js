/******************************************************************************/
/*
 *
 * Copyright 2012-2016 AOL Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this Software except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
'use strict';

var fs             = require('fs')
  , unzip          = require('unzip')
  , wiseSource     = require('./wiseSource.js')
  , util           = require('util')
  , HashTable      = require('hashtable')
  ;
//////////////////////////////////////////////////////////////////////////////////
function ThreatQSource (api, section) {
  ThreatQSource.super_.call(this, api, section);
  this.key          = api.getConfig("threatq", "key");
  this.host         = api.getConfig("threatq", "host");

  if (this.key === undefined) {
    console.log(this.section, "- No export key defined");
    return;
  }

  if (this.host === undefined) {
    console.log(this.section, "- No server host defined");
    return;
  }


  this.ips          = new HashTable();
  this.domains      = new HashTable();
  this.emails       = new HashTable();
  this.md5s         = new HashTable();
  this.cacheTimeout = -1;


  this.idField = this.api.addField("field:threatq.id;db:threatq.id;kind:integer;friendly:Id;help:ThreatQ Reference ID;shortcut:0;count:true");
  this.typeField = this.api.addField("field:threatq.type;db:threatq.type-term;kind:lotermfield;friendly:Type;help:Indicator Type;shortcut:1;count:true");
  this.sourceField = this.api.addField("field:threatq.source;db:threatq.source-term;kind:lotermfield;friendly:Source;help:Indicator Release Source;shortcut:2;count:true");
  this.campaignField = this.api.addField("field:threatq.campaign;db:threatq.campaign-term;kind:lotermfield;friendly:Campaign;help:Campaign Attribution;shortcut:3;count:true");

  this.api.addView("threatq", 
    "if (session.threatq)\n" +
    "  div.sessionDetailMeta.bold ThreatQ\n" +
    "  dl.sessionDetailMeta\n" +
    "    +arrayList(session.threatq, 'id', 'Id', 'threatq.id')\n" +
    "    +arrayList(session.threatq, 'type-term', 'Type', 'threatq.type')\n" +
    "    +arrayList(session.threatq, 'source-term', 'Source', 'threatq.source')\n" +
    "    +arrayList(session.threatq, 'campaign-term', 'Campaign', 'threatq.campaign')\n"
  );

  this.api.addRightClick("threatqip", {name:"ThreatQ", url:"https://" + this.host + "/search.php?search=%TEXT%", category:"ip"});
  this.api.addRightClick("threatqhost", {name:"ThreatQ", url:"https://" + this.host + "/search.php?search=%HOST%", category:"host"});
  this.api.addRightClick("threatqmd5", {name:"ThreatQ", url:"https://" + this.host + "/search.php?search=%TEXT%", category:"md5"});
  this.api.addRightClick("threatqid", {name:"ThreatQ", url:"https://" + this.host + "/network/%TEXT%", fields:"threatq.id"});

  setImmediate(this.loadFile.bind(this));
  setInterval(this.loadFile.bind(this), 24*60*60*1000); // Reload file every 24 hours

  this.api.addSource("threatq", this);
}
util.inherits(ThreatQSource, wiseSource);
//////////////////////////////////////////////////////////////////////////////////
ThreatQSource.prototype.parseFile = function()
{
  var self = this;
  self.ips.clear();
  self.domains.clear();
  self.emails.clear();
  self.md5s.clear();

  var count = 0;
  fs.createReadStream('/tmp/threatquotient.zip')
    .pipe(unzip.Parse())
    .on('entry', function (entry) {
      var bufs = [];
      entry.on('data', function (buf) {
        bufs.push(buf);
      }).on('end', function () {
        var json = JSON.parse(Buffer.concat(bufs));
        json.forEach(function (item) {
          var args = [self.idField, "" + item.id, self.typeField, item.type];

          if (item.source) {
            item.source.forEach(function (str) {
              args.push(self.sourceField, str);
            });
          }

          if (item.campaign) {
            item.campaign.forEach(function (str) {
              args.push(self.campaignField, str);
            });
          }

          var encoded = wiseSource.encode.apply(null, args);

          count++;
          if (item.type === "IP Address") {
            self.ips.put(item.indicator, {num: args.length/2, buffer: encoded});
          } else if (item.type === "FQDN") {
            self.domains.put(item.indicator, {num: args.length/2, buffer: encoded});
          } else if (item.type === "Email Address") {
            self.emails.put(item.indicator, {num: args.length/2, buffer: encoded});
          } else if (item.type === "MD5") {
            self.md5s.put(item.indicator, {num: args.length/2, buffer: encoded});
          }
        });
      });
    })
    .on('close', function () {
      console.log(self.section, "- Done Loading", count, "elements");
    });
};
//////////////////////////////////////////////////////////////////////////////////
ThreatQSource.prototype.loadFile = function() {
  var self = this;
  console.log(self.section, "- Downloading files");
  wiseSource.request('https://' + self.host + '/export/moloch/?export_key=' + self.key,  '/tmp/threatquotient.zip', function (statusCode) {
    if (statusCode === 200 || !self.loaded) {
      self.loaded = true;
      self.parseFile();
    }
  });
};
//////////////////////////////////////////////////////////////////////////////////
ThreatQSource.prototype.getDomain = function(domain, cb) {
  var domains = this.domains;
  cb(null, domains.get(domain) || domains.get(domain.substring(domain.indexOf(".")+1)));
};
//////////////////////////////////////////////////////////////////////////////////
ThreatQSource.prototype.getIp = function(ip, cb) {
  cb(null, this.ips.get(ip));
};
//////////////////////////////////////////////////////////////////////////////////
ThreatQSource.prototype.getMd5 = function(md5, cb) {
  cb(null, this.md5s.get(md5));
};
//////////////////////////////////////////////////////////////////////////////////
ThreatQSource.prototype.getEmail = function(email, cb) {
  cb(null, this.emails.get(email));
};
//////////////////////////////////////////////////////////////////////////////////
ThreatQSource.prototype.dump = function(res) {
  var self = this;
  ["ips", "domains", "emails", "md5s"].forEach(function (ckey) {
    res.write("" + ckey + ":\n");
    self[ckey].forEach(function (key, value) {
      var str = "{key: \"" + key + "\", ops:\n" +
        wiseSource.result2Str(wiseSource.combineResults([value])) + "},\n";
      res.write(str);
    });
  });
  res.end();
};
//////////////////////////////////////////////////////////////////////////////////
exports.initSource = function(api) {
  var source = new ThreatQSource(api, "threatq");
};
