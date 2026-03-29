const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

// Sur Railway, utiliser /data (volume persistant) si disponible
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'giftcard.db');

// Créer le dossier si nécessaire
const DB_DIR = path.dirname(DB_PATH);
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

let dbInstance = null;

function getDb() {
  if (!dbInstance) {
    dbInstance = new Database(DB_PATH);
    dbInstance.pragma('journal_mode = WAL');
    dbInstance.pragma('foreign_keys = ON');
  }
  return dbInstance;
}

function initializeDatabase() {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      phone TEXT,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'client' CHECK(role IN ('client', 'admin', 'seller')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS seller_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL UNIQUE,
      shop_name TEXT NOT NULL,
      description TEXT,
      logo_url TEXT DEFAULT '',
      wave_number TEXT,
      orange_number TEXT,
      commission_rate REAL NOT NULL DEFAULT 10,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','suspended')),
      admin_note TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      approved_at DATETIME,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      category TEXT NOT NULL,
      image_url TEXT,
      price INTEGER NOT NULL,
      denomination TEXT NOT NULL,
      platform TEXT NOT NULL,
      stock_count INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      seller_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (seller_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS cards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      code TEXT NOT NULL,
      pin TEXT,
      serial TEXT,
      status TEXT NOT NULL DEFAULT 'available',
      added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      sold_at DATETIME,
      order_id INTEGER,
      FOREIGN KEY (product_id) REFERENCES products(id),
      FOREIGN KEY (order_id) REFERENCES orders(id)
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      total_amount INTEGER NOT NULL,
      payment_method TEXT NOT NULL,
      payment_status TEXT NOT NULL DEFAULT 'pending',
      payment_ref TEXT,
      delivery_status TEXT NOT NULL DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      paid_at DATETIME,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      card_id INTEGER,
      quantity INTEGER NOT NULL DEFAULT 1,
      unit_price INTEGER NOT NULL,
      FOREIGN KEY (order_id) REFERENCES orders(id),
      FOREIGN KEY (product_id) REFERENCES products(id),
      FOREIGN KEY (card_id) REFERENCES cards(id)
    );

    CREATE TABLE IF NOT EXISTS seller_earnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      seller_id INTEGER NOT NULL,
      order_id INTEGER NOT NULL,
      order_item_id INTEGER NOT NULL,
      sale_amount INTEGER NOT NULL,
      commission_amount INTEGER NOT NULL,
      net_amount INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','available','withdrawn')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (seller_id) REFERENCES users(id),
      FOREIGN KEY (order_id) REFERENCES orders(id)
    );

    CREATE TABLE IF NOT EXISTS withdrawal_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      seller_id INTEGER NOT NULL,
      amount INTEGER NOT NULL,
      payment_method TEXT NOT NULL CHECK(payment_method IN ('wave','orange_money')),
      payment_number TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','paid','rejected')),
      admin_note TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      processed_at DATETIME,
      FOREIGN KEY (seller_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS site_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    CREATE INDEX IF NOT EXISTS idx_cards_product_status ON cards(product_id, status);
    CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
    CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
    CREATE INDEX IF NOT EXISTS idx_seller_earnings_seller ON seller_earnings(seller_id);
  `);

  migrateDatabase(db);
  seedDefaultData(db);
  console.log('Base de données initialisée.');
  return Promise.resolve(db);
}

function migrateDatabase(db) {
  // Add document columns to seller_profiles if missing
  try {
    const spCols = db.prepare("PRAGMA table_info(seller_profiles)").all().map(c => c.name);
    if (!spCols.includes('id_doc_url')) {
      db.prepare("ALTER TABLE seller_profiles ADD COLUMN id_doc_url TEXT DEFAULT ''").run();
      console.log('Migration: id_doc_url ajouté à seller_profiles.');
    }
    if (!spCols.includes('address_doc_url')) {
      db.prepare("ALTER TABLE seller_profiles ADD COLUMN address_doc_url TEXT DEFAULT ''").run();
      console.log('Migration: address_doc_url ajouté à seller_profiles.');
    }
    if (!spCols.includes('contact_email')) {
      db.prepare("ALTER TABLE seller_profiles ADD COLUMN contact_email TEXT DEFAULT ''").run();
      console.log('Migration: contact_email ajouté à seller_profiles.');
    }
    if (!spCols.includes('withdrawal_pin')) {
      db.prepare("ALTER TABLE seller_profiles ADD COLUMN withdrawal_pin TEXT DEFAULT NULL").run();
      console.log('Migration: withdrawal_pin ajouté à seller_profiles.');
    }
  } catch(e) { console.error('Migration seller_profiles docs:', e.message); }

  // Add name/price columns to cards if missing
  try {
    const cardCols = db.prepare("PRAGMA table_info(cards)").all().map(c => c.name);
    if (!cardCols.includes('card_name')) {
      db.prepare("ALTER TABLE cards ADD COLUMN card_name TEXT DEFAULT ''").run();
      console.log('Migration: card_name ajouté à cards.');
    }
    if (!cardCols.includes('card_price')) {
      db.prepare("ALTER TABLE cards ADD COLUMN card_price REAL DEFAULT 0").run();
      console.log('Migration: card_price ajouté à cards.');
    }
  } catch(e) { console.error('Migration seller_profiles docs:', e.message); }

  // Add delivery_email/delivery_phone to orders if missing
  try {
    const orderCols = db.prepare("PRAGMA table_info(orders)").all().map(c => c.name);
    if (!orderCols.includes('delivery_email')) {
      db.prepare("ALTER TABLE orders ADD COLUMN delivery_email TEXT DEFAULT ''").run();
    }
    if (!orderCols.includes('delivery_phone')) {
      db.prepare("ALTER TABLE orders ADD COLUMN delivery_phone TEXT DEFAULT ''").run();
    }
  } catch(e) { console.error('Migration orders delivery:', e.message); }

  // Create password_reset_tokens table if missing
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS password_reset_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        token TEXT NOT NULL UNIQUE,
        expires_at DATETIME NOT NULL,
        used INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `);
  } catch(e) { console.error('Migration password_reset_tokens:', e.message); }

  // Add seller_id column to products if it doesn't exist
  try {
    const cols = db.prepare("PRAGMA table_info(products)").all().map(c => c.name);
    if (!cols.includes('seller_id')) {
      db.prepare("ALTER TABLE products ADD COLUMN seller_id INTEGER REFERENCES users(id)").run();
      db.prepare("CREATE INDEX IF NOT EXISTS idx_products_seller ON products(seller_id)").run();
      console.log('Migration: seller_id ajouté à products.');
    } else {
      db.prepare("CREATE INDEX IF NOT EXISTS idx_products_seller ON products(seller_id)").run();
    }
  } catch(e) { console.error('Migration products:', e.message); }

  // Fix users role CHECK constraint to include 'seller' if needed
  // SQLite doesn't allow altering constraints, so we recreate the table if necessary
  try {
    const usersSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get();
    if (usersSql && usersSql.sql && !usersSql.sql.includes("'seller'")) {
      console.log('Migration: mise à jour contrainte role users...');
      db.exec(`
        PRAGMA foreign_keys = OFF;
        BEGIN;
        CREATE TABLE IF NOT EXISTS users_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          email TEXT UNIQUE NOT NULL,
          phone TEXT,
          password_hash TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'client' CHECK(role IN ('client', 'admin', 'seller')),
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO users_new SELECT * FROM users;
        DROP TABLE users;
        ALTER TABLE users_new RENAME TO users;
        CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
        COMMIT;
        PRAGMA foreign_keys = ON;
      `);
      console.log('Migration users: contrainte role mise à jour.');
    }
  } catch(e) { console.error('Migration users constraint:', e.message); }

  // Ajouter seller_id aux cards
  try {
    const cardCols2 = db.prepare("PRAGMA table_info(cards)").all().map(c => c.name);
    if (!cardCols2.includes('seller_id')) {
      db.prepare("ALTER TABLE cards ADD COLUMN seller_id INTEGER").run();
      console.log('Migration: seller_id ajouté à cards.');
    }
  } catch(e) { console.error('Migration cards seller_id:', e.message); }

  // Table logs admin
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS admin_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        admin_id INTEGER NOT NULL,
        admin_email TEXT NOT NULL,
        action TEXT NOT NULL,
        target TEXT,
        details TEXT,
        ip TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
  } catch(e) { console.error('Migration admin_logs:', e.message); }

  console.log('Migration vérifiée.');
}

function seedDefaultData(db) {
  // Migrer l'ancien compte admin si nécessaire
  const oldAdmin = db.prepare('SELECT id FROM users WHERE email = ?').get('admin@giftcardci.com');
  if (oldAdmin) {
    db.prepare('UPDATE users SET email = ?, name = ? WHERE email = ?').run('babicardci@gmail.com', 'Administrateur', 'admin@giftcardci.com');
    console.log('Admin: email migré → babicardci@gmail.com');
  }

  const adminExists = db.prepare('SELECT id, role FROM users WHERE email = ?').get('babicardci@gmail.com');
  if (!adminExists) {
    const hash = bcrypt.hashSync('Admin@2024!', 10);
    db.prepare(`INSERT OR IGNORE INTO users (name, email, phone, password_hash, role) VALUES (?, ?, ?, ?, ?)`).run('Administrateur', 'babicardci@gmail.com', '+2250708598080', hash, 'admin');
    console.log('Admin créé: babicardci@gmail.com (voir variables env pour le mot de passe)');
  } else if (adminExists.role !== 'admin') {
    db.prepare('UPDATE users SET role = ? WHERE email = ?').run('admin', 'babicardci@gmail.com');
    console.log('Admin: rôle corrigé → admin');
  }

  const productCount = db.prepare('SELECT COUNT(*) as count FROM products WHERE seller_id IS NULL').get();
  if (!productCount || productCount.count === 0) {
    const products = [
      { name: 'iTunes Gift Card 5$', description: 'Carte cadeau iTunes / App Store valable aux USA.', category: 'apple', price: 3200, denomination: '5$', platform: 'iTunes / App Store' },
      { name: 'iTunes Gift Card 10$', description: 'Carte cadeau iTunes / App Store valable aux USA.', category: 'apple', price: 6200, denomination: '10$', platform: 'iTunes / App Store' },
      { name: 'iTunes Gift Card 25$', description: 'Carte cadeau iTunes / App Store valable aux USA.', category: 'apple', price: 15200, denomination: '25$', platform: 'iTunes / App Store' },
      { name: 'PSN Card 10$', description: 'PlayStation Network Gift Card.', category: 'playstation', price: 6500, denomination: '10$', platform: 'PlayStation Network' },
      { name: 'PSN Card 20$', description: 'PlayStation Network Gift Card.', category: 'playstation', price: 12500, denomination: '20$', platform: 'PlayStation Network' },
      { name: 'PSN Card 50$', description: 'PlayStation Network Gift Card.', category: 'playstation', price: 30500, denomination: '50$', platform: 'PlayStation Network' },
      { name: 'Xbox Gift Card 10$', description: 'Microsoft Xbox Gift Card.', category: 'xbox', price: 6500, denomination: '10$', platform: 'Xbox / Microsoft Store' },
      { name: 'Xbox Gift Card 25$', description: 'Microsoft Xbox Gift Card.', category: 'xbox', price: 15500, denomination: '25$', platform: 'Xbox / Microsoft Store' },
      { name: 'Google Play 10$', description: 'Google Play Gift Card.', category: 'google', price: 6200, denomination: '10$', platform: 'Google Play Store' },
      { name: 'Google Play 25$', description: 'Google Play Gift Card.', category: 'google', price: 15200, denomination: '25$', platform: 'Google Play Store' },
      { name: 'Steam Wallet 10$', description: 'Carte Steam Wallet.', category: 'steam', price: 6500, denomination: '10$', platform: 'Steam' },
      { name: 'Steam Wallet 20$', description: 'Carte Steam Wallet.', category: 'steam', price: 12500, denomination: '20$', platform: 'Steam' },
      { name: 'Netflix Gift Card 30$', description: 'Carte cadeau Netflix.', category: 'netflix', price: 19000, denomination: '30$', platform: 'Netflix' },
      { name: 'Amazon Gift Card 10$', description: 'Carte cadeau Amazon.', category: 'amazon', price: 6500, denomination: '10$', platform: 'Amazon' }
    ];
    const insert = db.prepare(`INSERT INTO products (name, description, category, image_url, price, denomination, platform, stock_count, is_active, seller_id) VALUES (?, ?, ?, '', ?, ?, ?, 0, 1, NULL)`);
    for (const p of products) insert.run(p.name, p.description, p.category, p.price, p.denomination, p.platform);
    console.log(`${products.length} produits créés.`);
  }
}

module.exports = { getDb, initializeDatabase };
