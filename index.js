import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import session from "express-session";
import bcrypt from "bcrypt";
import passport from "passport";
import { Strategy } from "passport-local";
import "dotenv/config";
import { neon } from "@neondatabase/serverless";

dotenv.config({ path: "./.env" });
const sql = neon(process.env.DATABASE_URL);
const saltRounds = 10;

const app = express();

app.use(
  cors({
    origin: process.env.FRONTEND_URL,
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

const port = process.env.PORT || 4000;

async function testConnection() {
  try {
    const result = await sql`SELECT NOW() as now`;
    console.log("Connected! Current time:", result[0].now);
  } catch (error) {
    console.error("Failed to connect to DB:", error);
  }
}

testConnection();

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
    const result =
      await sql`SELECT r.user_id, u.username, b.cover_url, b.author, b.title, r.review, r.id, r.created_at, r.book_id
        FROM users u
        JOIN reviews r ON r.user_id=u.id
        JOIN books b ON r.book_id=b.id
        ORDER BY r.created_at
        DESC LIMIT ${limit} OFFSET ${offset}`;
    return res.status(200).json({ reviews: result });
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
    const result = await sql`SELECT id, content, created_at FROM notes
        WHERE book_id = ${book_id} AND user_id = ${user_id}
        ORDER BY created_at
        DESC LIMIT ${limit} OFFSET ${offset}`;
    return res.status(200).json({ notes: result });
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
    const result =
      await sql`SELECT * FROM users where (username = ${username} or email = ${email})`;
    console.log("/register");
    console.log(result);
    if (result.length > 0) {
      return res.status(409).json({ error: "Email already registered" });
    } else {
      bcrypt.hash(password, saltRounds, async (err, hash) => {
        if (err) {
          return res.status(500).send({ error: `${err}` });
        } else {
          const result =
            await sql`INSERT INTO users (username, email, password_hash) VALUES (${username}, ${email}, ${hash}) RETURNING *`;
          const user = result[0];
          console.log(user);
          console.log(result);
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
  const title = req.body.title;
  const cover_url = req.body.cover_url;
  const author = req.body.author;
  const review = req.body.review;
  const rating = parseInt(req.body.rating);
  const note = req.body.note;

  try {
    const bookResponse = await sql`WITH ins AS (
        INSERT INTO books (title, cover_url, author)
        VALUES(${title}, ${cover_url}, ${author})
        ON CONFLICT (title) DO NOTHING
        RETURNING *
        )
      SELECT * FROM ins
      UNION ALL
      SELECT * FROM books WHERE title=$1 AND NOT EXISTS (SELECT $1 FROM ins)`;
    const book_id = bookResponse[0].id;
    if (review !== "") {
      await sql`INSERT INTO reviews (book_id, user_id, review, rating)
            VALUES(${book_id}, ${user_id}, ${review}, ${rating})`;
    }
    if (note !== "") {
      await sql`INSERT INTO notes (user_id, book_id, content)
            VALUES(${user_id}, ${book_id}, ${note})`;
    }

    return res.status(201).send("Created successfully");
  } catch (err) {
    return res.status(500).json({ error: `${err}` });
  }
});

passport.use(
  new Strategy(async (user, password, done) => {
    try {
      const result =
        await sql`SELECT * FROM users WHERE email=${user} OR username=${user}`;
      console.log(result);
      if (result.length > 0) {
        const user = result[0];
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
  console.log("serializeUser");
  console.log(user);
  done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
  console.log(id);
  try {
    const result = await sql`SELECT * FROM users WHERE id=${id}`;
    console.log("deserialize");
    console.log(result);
    if (result.length == 0) {
      return done(new Error("User not found"));
    }
    done(null, result[0]);
  } catch (err) {
    done(err);
  }
});

app.listen(port, () => {
  console.log(`Listening on port: ${port}`);
});
