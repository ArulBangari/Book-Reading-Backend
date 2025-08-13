import pg from "pg";
import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import session from "express-session";
import bcrypt from "bcrypt";
import passport from "passport";
import { Strategy } from "passport-local";

dotenv.config({ path: "./.env" });
const saltRounds = 10;

const app = express();

app.use(
  cors({
    origin: "http://localhost:3000",
    credentials: true,
  })
);

app.use(
  session({
    secret: process.env.SECRET_WORD,
    resave: false,
    saveUninitialized: true,
    cookie: {
      maxAge: 1000 * 60 * 60 * 24,
    },
  })
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(passport.initialize());
app.use(passport.session());

const port = 4000;

const db = new pg.Client({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_DATABASE,
  password: process.env.DB_PASSWORD,
  port: process.env.PORT,
});
db.connect();

app.get("/", async (req, res) => {
  const response = await db.query("SELECT * FROM books");
});

app.get("/current-user", (req, res) => {
  if (req.isAuthenticated()) {
    res.json({
      loggedIn: true,
      username: req.user.username,
    });
  } else {
    res.json({ loggedIn: false });
  }
});

app.get("/posts", async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = 10;
  const offset = (page - 1) * limit;

  try {
    const result = await db.query(
      `SELECT r.user_id, u.username, b.cover_url, b.author, b.title, r.review, r.id, r.created_at, r.book_id
        FROM users u
        JOIN reviews r ON r.user_id=u.id
        JOIN books b ON r.book_id=b.id
        ORDER BY r.created_at
        DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    return res.status(200).json({ reviews: result.rows });
  } catch (err) {
    return res.status(500).json({ error: err });
  }
});

app.get("/notes", async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = 10;
  const offset = (page - 1) * limit;
  const book_id = req.query.book_id;
  const user_id = req.query.user_id;

  if (!book_id) {
    return res.status(400).json({ error: "Missing book_id parameter" });
  }

  try {
    const result = await db.query(
      `SELECT id, content, created_at FROM notes WHERE book_id = $1 AND user_id=$2 ORDER BY created_at DESC LIMIT $3 OFFSET $4`,
      [book_id, user_id, limit, offset]
    );
    return res.status(200).json({ notes: result.rows });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/login", (req, res, next) => {
  passport.authenticate("local", (err, user, info) => {
    if (err) return next(err);
    if (!user) {
      return res
        .status(401)
        .json({ success: false, error: info.message || "Login failed" });
    }
    req.login(user, (err) => {
      if (err) return next(err);
      return res.status(200).json({ success: true, username: user.username });
    });
  })(req, res, next);
});

app.post("/register", async (req, res) => {
  const username = req.body.username;
  const email = req.body.email;
  const password = req.body.password;
  try {
    const result = await db.query(
      `SELECT * FROM users where (username=$1 or email=$2)`,
      [username, email]
    );
    if (result.rows.length > 0) {
      return res.status(409).json({ error: "Email already registered" });
    } else {
      bcrypt.hash(password, saltRounds, async (err, hash) => {
        if (err) {
          return res.status(500).send({ error: `${err}` });
        } else {
          const result = await db.query(
            "INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING *",
            [username, email, hash]
          );
          const user = result.rows[0];
          req.login(user, (err) => {
            if (err) return next(error);
            return res
              .status(200)
              .json({ success: true, username: user.username });
          });
        }
      });
    }
  } catch (err) {
    return res.status(500).send({ error: `${err}` });
  }
});

app.post("/add/", async (req, res) => {
  if (!req.isAuthenticated()) {
    return res
      .status(401)
      .json({ error: "Authentication required. Please log in" });
  }

  if (req.body.review === "" && req.body.note === "") {
    return res
      .status(400)
      .json({ error: "At least one of 'review' or 'note' must be provided." });
  }

  const user_id = req.user.id;
  try {
    const bookResponse = await db.query(
      `WITH ins AS (
        INSERT INTO books (title, cover_url, author)
        VALUES($1, $2, $3)
        ON CONFLICT (title) DO NOTHING
        RETURNING *
        )
      SELECT * FROM ins
      UNION ALL
      SELECT * FROM books WHERE title=$1 AND NOT EXISTS (SELECT $1 FROM ins)`,
      [req.body.title, req.body.cover_url, req.body.author]
    );
    const book_id = bookResponse.rows[0].id;
    if (req.body.review !== "") {
      await db.query(
        `INSERT INTO reviews (book_id, user_id, review, rating)
            VALUES($1, $2, $3, $4)`,
        [book_id, user_id, req.body.review, parseInt(req.body.rating)]
      );
    }
    if (req.body.note !== "") {
      await db.query(
        `INSERT INTO notes (user_id, book_id, content)
            VALUES($1, $2, $3)`,
        [user_id, book_id, req.body.note]
      );
    }

    return res.status(201).send("Created successfully");
  } catch (err) {
    return res.status(500).json({ error: `${err}` });
  }
});

passport.use(
  new Strategy(async (user, password, done) => {
    try {
      const result = await db.query(
        "SELECT * FROM users WHERE email=$1 OR username=$1",
        [user]
      );
      if (result.rows.length > 0) {
        const user = result.rows[0];
        const storedHashedPassword = user.password_hash;
        try {
          const match = await bcrypt.compare(password, storedHashedPassword);
          if (match) {
            return done(null, user);
          } else {
            return done(null, false, { message: "Incorrect password" });
          }
        } catch (err) {
          return done(err);
        }
      }
      return done(null, false, { message: "User not found" });
    } catch (err) {
      return done(err);
    }
  })
);

passport.serializeUser((user, done) => {
  done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
  try {
    const result = await db.query(`SELECT * FROM users WHERE id=$1`, [id]);
    if (result.rows.length == 0) {
      return done(new Error("User not found"));
    }
    done(null, result.rows[0]);
  } catch (err) {
    done(err);
  }
});

app.listen(port, () => {
  console.log(`Listening on port: ${port}`);
});
