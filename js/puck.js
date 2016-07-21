/* 
--------------------------------------------------------------------
Puck.js BLE Interface library
                      Copyright 2016 Gordon Williams (gw@pur3.co.uk)
--------------------------------------------------------------------
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at http://mozilla.org/MPL/2.0/.
--------------------------------------------------------------------
This creates a 'Puck' object that can be used from the Web Browser.

Simple usage:

  Puck.write("LED1.set()\n")

Execute expression and return the result:

  Puck.eval("BTN.read()", function(d) {
    alert(d);
  });

Or write and wait for a result - this will return all characters, 
including echo and linefeed from the REPL so you may want to send
`echo(0)` and use `console.log` when doing this.

  Puck.write("1+2\n", function(d) {
    alert(d);
  });

Or more advanced usage with control of the connection
 - allows multiple connections

  Puck.connect(function(connection) {
    if (!connection) throw "Error!";
    connection.on('data', function(d) { ... });
    connection.on('close', function() { ... });
    connection.write("1+2\n", function() {
      connection.close();
    });
  });

*/
var Puck = (function() {
  if (typeof navigator == "undefined") return; // not running in a web browser
  if (!navigator.bluetooth) {
    console.log("No navigator.bluetooth - Web Bluetooth not enabled");
    return;
  }

  var NORDIC_SERVICE = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
  var NORDIC_TX = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";
  var NORDIC_RX = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";
  var CHUNKSIZE = 16;

  function log(s) {
    if (puck.log) puck.log(s);
  }  
  
  function ab2str(buf) {
    return String.fromCharCode.apply(null, new Uint8Array(buf));
  }
  
  function str2ab(str) {
    var buf = new ArrayBuffer(str.length);
    var bufView = new Uint8Array(buf);
    for (var i=0, strLen=str.length; i<strLen; i++) {
      bufView[i] = str.charCodeAt(i);
    }
    return buf;
  }


  function connect(callback) {
    var connection = {
      on : function(evt,cb) { this["on"+evt]=cb; },
      emit : function(evt,data) { if (this["on"+evt]) this["on"+evt](data); },
      isOpen : false
    };
    var btServer = undefined;
    var btService;
    var connectionDisconnectCallback;
    var txCharacteristic;
    var rxCharacteristic;
    var txDataQueue = [];
    var txInProgress = false;

    connection.close = function() {
      if (btServer) {
        btServer.disconnect();
        btServer = undefined;
        txCharacteristic = undefined;
        rxCharacteristic = undefined;
        if (connection.isOpen) {
          connection.isOpen = false;
          connection.emit('close');       
        } else callback(null);      
      }
    };
   
    connection.write = function(data, callback) {
      if (!txCharacteristic) return;
      txDataQueue.push({data:data,callback:callback});
      if (!txInProgress) writeChunk();
  
      function writeChunk() {
        var chunk;
        
        var txItem = txDataQueue[0];
        if (txItem.data.length <= CHUNKSIZE) {
          chunk = txItem.data;
          txItem.data = undefined;
        } else {
          chunk = txItem.data.substr(0,CHUNKSIZE);
          txItem.data = txItem.data.substr(CHUNKSIZE);
        }
        txInProgress = true;
        log("BT> Sending "+ JSON.stringify(chunk));
        txCharacteristic.writeValue(str2ab(chunk)).then(function() {
          log("BT> Sent");
          if (!txItem.data) {
            txDataQueue.shift(); // remove this element
            txItem.callback();
          }
          txInProgress = false;        
          if (txDataQueue.length)
            writeChunk();
        }).catch(function(error) {
         log('BT> SEND ERROR: ' + error);
         txDataQueue = [];
         connection.close();
        });
      }
    };

    navigator.bluetooth.requestDevice({filters:[{services:[ NORDIC_SERVICE ]}]}).then(function(device) {
      log('BT>  Device Name:       ' + device.name);
      log('BT>  Device ID:         ' + device.id);
      log('BT>  Device UUIDs:      ' + device.uuids.join('\n' + ' '.repeat(21)));
      device.addEventListener('gattserverdisconnected', function() {
        log("BT> Disconnected (gattserverdisconnected)");
        connection.close();
      });
      return device.gatt.connect();
    }).then(function(server) {
      log("BT> Connected");
      btServer = server;
      return server.getPrimaryService(NORDIC_SERVICE);
    }).then(function(service) {
      log("BT> Got service");
      btService = service;
      return btService.getCharacteristic(NORDIC_RX);
    }).then(function (characteristic) {
      rxCharacteristic = characteristic;
      log("BT> RX characteristic:"+JSON.stringify(rxCharacteristic));
      rxCharacteristic.addEventListener('characteristicvaluechanged', function(event) {
        var value = event.target.value.buffer; // get arraybuffer
        connection.emit('data', ab2str(value));
      });
      return rxCharacteristic.startNotifications();
    }).then(function() {
      return btService.getCharacteristic(NORDIC_TX);
    }).then(function (characteristic) {
      txCharacteristic = characteristic;
      log("BT> TX characteristic:"+JSON.stringify(txCharacteristic));
    }).then(function() {
      txDataQueue = [];
      txInProgress = false;
      connection.isOpen = true;
      callback(connection);
      connection.emit('open');
    }).catch(function(error) {
      log('BT> ERROR: ' + error);
      connection.close();
    });
    return connection;
  };

  // ----------------------------------------------------------
  // convenience function...
  var connection;
  function write(data, callback) {
    function onWritten() {
      if (callback) {
        // wait for any received data if we have a callback...
        var maxTime = 10;
        setTimeout(function timeout() {
          if (connection.hadData && maxTime--) {
            setTimeout(timeout, 250);
          } else {
            callback(connection.received);
            connection.received = "";
          }
          connection.hadData = false;
        }, 250);
      } else connection.received = "";
    }

    if (connection && connection.isOpen) {
      connection.received = "";
      return connection.write(data, onWritten);
    }

    connection = connect(function(puck) {     
      if (!puck) {
        connection = undefined;
        callback(null);
      }
      connection.received = "";
      connection.on('data', function(d) { 
        connection.received += d; 
        connection.hadData = true;
      });
      connection.write(data, onWritten);
    });
  }

  // ----------------------------------------------------------

  var puck = {
    log : function(s) {console.log(s)},
    connect : connect,
    write : write,
    eval : function(expr, cb) { write('\x10Bluetooth.print(JSON.stringify('+expr+'))\n', cb); }
  };
  return puck;
})();
