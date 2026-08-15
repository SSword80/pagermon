exports.up = function(db) {
  return db.schema.table('messages', function(table) {
    table.string('protocol', 32);
  });
};

exports.down = function(db) {
  return db.schema.table('messages', function(table) {
    table.dropColumn('protocol');
  });
};
