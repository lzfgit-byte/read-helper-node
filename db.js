const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

async function createDatabase(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const SQL = await initSqlJs();
  let db;
  if (fs.existsSync(dbPath)) {
    const buffer = fs.readFileSync(dbPath);
    db = new SQL.Database(new Uint8Array(buffer));
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS books (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      author TEXT,
      description TEXT,
      cover_img TEXT,
      source_path TEXT,
      stored_path TEXT NOT NULL,
      file_name TEXT,
      size TEXT,
      file_type TEXT,
      created_at TEXT
    );
  `);

  function saveDb() {
    const data = db.export();
    fs.writeFileSync(dbPath, Buffer.from(data));
  }

  function normalizeRow(row) {
    if (!row) {
      return row;
    }
    return {
      id: row.id,
      title: row.title,
      author: row.author,
      description: row.description,
      coverImg: row.cover_img || row.coverImg,
      sourcePath: row.source_path || row.sourcePath,
      storedPath: row.stored_path || row.storedPath,
      fileName: row.file_name || row.fileName,
      size: row.size,
      fileType: row.file_type || row.fileType,
      createdAt: row.created_at || row.createdAt
    };
  }

  return {
    listBooks: () => {
      const stmt = db.prepare('SELECT * FROM books ORDER BY created_at DESC');
      const rows = [];
      while (stmt.step()) {
        rows.push(normalizeRow(stmt.getAsObject()));
      }
      stmt.free();
      return rows;
    },
    getBookById: (id) => {
      const stmt = db.prepare('SELECT * FROM books WHERE id = ?');
      stmt.bind([id]);
      const row = stmt.step() ? normalizeRow(stmt.getAsObject()) : null;
      stmt.free();
      return row;
    },
    deleteBook: (id) => {
      const stmt = db.prepare('DELETE FROM books WHERE id = ?');
      stmt.run([id]);
      stmt.free();
      saveDb();
    },
    insertBook: (book) => {
      const stmt = db.prepare(`
        INSERT INTO books (
          title, author, description, cover_img,
          source_path, stored_path, file_name, size,
          file_type, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run([
        book.title,
        book.author,
        book.description,
        book.coverImg,
        book.sourcePath,
        book.storedPath,
        book.fileName,
        book.size,
        book.fileType,
        book.createdAt
      ]);
      stmt.free();
      const result = db.exec('SELECT last_insert_rowid() AS id');
      saveDb();
      const id = result[0].values[0][0];
      return { id, ...book };
    }
  };
}

module.exports = { createDatabase };
