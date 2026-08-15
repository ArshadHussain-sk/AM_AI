import sqlite3
import os
import time
import hashlib

DB_PATH = os.path.join(os.path.dirname(__file__), "am_ai.db")

def get_db_connection():
    """Establishes a connection to the SQLite database with thread-safety disabled for FastAPI concurrent threads."""
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    """Initializes the schema tables if they do not exist."""
    conn = get_db_connection()
    cursor = conn.cursor()
    
    # 1. Create Users Table
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            salt TEXT NOT NULL,
            created_at REAL NOT NULL
        )
    """)
    
    # 2. Create Jobs Table
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS jobs (
            job_id TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            filename TEXT NOT NULL,
            ext TEXT NOT NULL,
            size INTEGER NOT NULL,
            duration REAL NOT NULL,
            status TEXT NOT NULL,
            progress INTEGER NOT NULL DEFAULT 0,
            mode TEXT NOT NULL,
            model TEXT NOT NULL,
            normalize INTEGER NOT NULL DEFAULT 0,
            noise_gate INTEGER NOT NULL DEFAULT 0,
            error TEXT,
            created_at REAL NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    """)
    
    # 3. Create Stems Table
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS stems (
            job_id TEXT PRIMARY KEY,
            vocals TEXT,
            instrumental TEXT,
            drums TEXT,
            bass TEXT,
            other TEXT,
            guitar TEXT,
            piano TEXT,
            FOREIGN KEY (job_id) REFERENCES jobs(job_id) ON DELETE CASCADE
        )
    """)
    
    conn.commit()
    conn.close()

# Password Hashing Helper Utilities
def hash_password(password: str, salt: str = None) -> tuple[str, str]:
    """Hashes a password using PBKDF2-HMAC-SHA256."""
    if salt is None:
        salt = os.urandom(16).hex()
    pwd_bytes = password.encode('utf-8')
    salt_bytes = bytes.fromhex(salt)
    # Perform 100,000 rounds of PBKDF2
    hash_bytes = hashlib.pbkdf2_hmac('sha256', pwd_bytes, salt_bytes, 100000)
    return hash_bytes.hex(), salt

# Authentication API
def create_user(username: str, password: str) -> int:
    """Registers a new user and returns the user_id, or -1 if the username is taken."""
    username = username.strip().lower()
    if not username or not password:
        return -1
        
    password_hash, salt = hash_password(password)
    
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        cursor.execute(
            "INSERT INTO users (username, password_hash, salt, created_at) VALUES (?, ?, ?, ?)",
            (username, password_hash, salt, time.time())
        )
        conn.commit()
        user_id = cursor.lastrowid
        return user_id
    except sqlite3.IntegrityError:
        return -1  # Username already exists
    finally:
        conn.close()

def authenticate_user(username: str, password: str) -> dict:
    """Authenticates credentials against stored hashes. Returns user Row dict if successful, else None."""
    username = username.strip().lower()
    if not username or not password:
        return None
        
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM users WHERE username = ?", (username,))
    user = cursor.fetchone()
    conn.close()
    
    if not user:
        return None
        
    user_dict = dict(user)
    check_hash, _ = hash_password(password, user_dict["salt"])
    if check_hash == user_dict["password_hash"]:
        return user_dict
    return None

# Separation Jobs Management
def add_job(job_id: str, user_id: int, filename: str, ext: str, size: int, duration: float, mode: str, model: str, normalize: bool, noise_gate: bool):
    """Creates a new separation task entry in the SQLite database."""
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute(
        """
        INSERT INTO jobs (job_id, user_id, filename, ext, size, duration, status, progress, mode, model, normalize, noise_gate, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (job_id, user_id, filename, ext, size, duration, "queued", 0, mode, model, 1 if normalize else 0, 1 if noise_gate else 0, time.time())
    )
    conn.commit()
    conn.close()

def update_job_status(job_id: str, status: str, progress: int, error: str = None):
    """Updates progress and status details for a running job."""
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute(
        "UPDATE jobs SET status = ?, progress = ?, error = ? WHERE job_id = ?",
        (status, progress, error, job_id)
    )
    conn.commit()
    conn.close()

def save_job_stems(job_id: str, stems_dict: dict):
    """Saves the separated file path locations to the stems table."""
    conn = get_db_connection()
    cursor = conn.cursor()
    
    # Check if a stems entry already exists
    cursor.execute("SELECT 1 FROM stems WHERE job_id = ?", (job_id,))
    exists = cursor.fetchone()
    
    cols = ["vocals", "instrumental", "drums", "bass", "other", "guitar", "piano"]
    vals = [stems_dict.get(c) for c in cols]
    
    if exists:
        # Update
        update_str = ", ".join([f"{c} = ?" for c in cols])
        cursor.execute(
            f"UPDATE stems SET {update_str} WHERE job_id = ?",
            (*vals, job_id)
        )
    else:
        # Insert
        placeholders = ", ".join(["?"] * (len(cols) + 1))
        cursor.execute(
            f"INSERT INTO stems (job_id, {', '.join(cols)}) VALUES ({placeholders})",
            (job_id, *vals)
        )
        
    conn.commit()
    conn.close()

def get_job(job_id: str) -> dict:
    """Returns the job configuration and files list."""
    conn = get_db_connection()
    cursor = conn.cursor()
    
    cursor.execute("SELECT * FROM jobs WHERE job_id = ?", (job_id,))
    job = cursor.fetchone()
    
    if not job:
        conn.close()
        return None
        
    job_dict = dict(job)
    
    cursor.execute("SELECT * FROM stems WHERE job_id = ?", (job_id,))
    stems = cursor.fetchone()
    if stems:
        job_dict["stems"] = dict(stems)
    else:
        job_dict["stems"] = {}
        
    conn.close()
    return job_dict

def get_user_jobs(user_id: int) -> list:
    """Returns all jobs belonging to a specific user, ordered chronologically (newest first)."""
    conn = get_db_connection()
    cursor = conn.cursor()
    
    cursor.execute("SELECT * FROM jobs WHERE user_id = ? ORDER BY created_at DESC", (user_id,))
    jobs = cursor.fetchall()
    
    results = []
    for job in jobs:
        job_dict = dict(job)
        cursor.execute("SELECT * FROM stems WHERE job_id = ?", (job_dict["job_id"],))
        stems = cursor.fetchone()
        if stems:
            job_dict["stems"] = dict(stems)
        else:
            job_dict["stems"] = {}
        results.append(job_dict)
        
    conn.close()
    return results

def delete_user_job(job_id: str, user_id: int) -> bool:
    """Deletes a job entry if it belongs to the given user."""
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("DELETE FROM jobs WHERE job_id = ? AND user_id = ?", (job_id, user_id))
    conn.commit()
    rows_deleted = cursor.rowcount
    conn.close()
    return rows_deleted > 0

def clear_user_history(user_id: int):
    """Deletes all job logs associated with a user."""
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("DELETE FROM jobs WHERE user_id = ?", (user_id,))
    conn.commit()
    conn.close()
