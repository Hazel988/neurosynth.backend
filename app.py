# app.py
import os
import re
import tempfile
from typing import List, Tuple, Dict, Any, Optional
from urllib.parse import unquote

import numpy as np
import uvicorn
from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import HTMLResponse, FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine

app = FastAPI(title="Neurosynth & LoTUS-BF Backend")

# 1. 加入 CORS 標頭，允許跨來源請求
@app.middleware("http")
async def add_cors_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["Access-Control-Allow-Origin"] = "*"
    return response

# 2. 資料庫連線配置 (自動相容 Render 的 postgres:// 與環境變數 DB_URL)
_engine = None

def get_engine() -> Engine:
    global _engine
    if _engine is not None:
        return _engine
    # 支援 Render 提供的 DB_URL 或 DATABASE_URL，若無則連線至預設資料庫
    db_url = os.getenv("DB_URL") or os.getenv("DATABASE_URL") or "postgresql://tren:e04gk6ak7@mil.psy.ntu.edu.tw/neurosynth"
    if db_url.startswith("postgres://"):
        db_url = "postgresql://" + db_url[len("postgres://"):]
    _engine = create_engine(db_url, pool_pre_ping=True)
    return _engine

def clean_term(term_str: str) -> str:
    """處理 URL 解碼，將底線轉換回空格並轉小寫"""
    decoded = unquote(term_str)
    return decoded.replace("_", " ").strip().lower()

def parse_coords(coord_str: str):
    """解析 x_y_z 座標為 (x, y, z) 整數 tuple，支援小數與空格防呆"""
    parts = [p.strip() for p in coord_str.strip().split("_")]
    if len(parts) != 3:
        raise ValueError(f"座標格式錯誤 '{coord_str}'，應為 'x_y_z'（例如 0_-52_26）。")
    try:
        return int(round(float(parts[0]))), int(round(float(parts[1]))), int(round(float(parts[2])))
    except (ValueError, OverflowError):
        raise ValueError(f"座標數值無效 '{coord_str}'，各軸必須為數字。")

def require_nonempty(name: str, value: str):
    if not value:
        raise HTTPException(status_code=400, detail=f"{name} 不可為空。")

def term_exists(conn, term: str) -> bool:
    sql = text("""
        SELECT EXISTS (
            SELECT 1 FROM ns.annotations_terms
            WHERE (LOWER(term) = :term OR LOWER(term) = 'terms_abstract_tfidf__' || :term)
        );
    """)
    return bool(conn.execute(sql, {"term": term}).scalar())

def coord_exists(conn, x: int, y: int, z: int) -> bool:
    sql = text("""
        SELECT EXISTS (
            SELECT 1 FROM ns.coordinates
            WHERE ST_X(geom) = :x AND ST_Y(geom) = :y AND ST_Z(geom) = :z
        );
    """)
    return bool(conn.execute(sql, {"x": x, "y": y, "z": z}).scalar())

# -------------------------------------------------------------
# Week 8 核心端點：解離 (Dissociate)
# -------------------------------------------------------------

@app.get("/img")
async def show_img():
    if not os.path.exists("amygdala.gif"):
        raise HTTPException(status_code=404, detail="Image not found")
    return FileResponse("amygdala.gif", media_type="image/gif")

@app.get("/dissociate/terms/{term_a:path}/{term_b:path}")
async def dissociate_terms(term_a: str, term_b: str):
    clean_a = clean_term(term_a)
    clean_b = clean_term(term_b)
    require_nonempty("term_a", clean_a)
    require_nonempty("term_b", clean_b)

    eng = get_engine()
    sql = text("""
    SELECT DISTINCT study_id 
    FROM ns.annotations_terms 
    WHERE (LOWER(term) = :term_a OR LOWER(term) = 'terms_abstract_tfidf__' || :term_a)
    EXCEPT
    SELECT DISTINCT study_id 
    FROM ns.annotations_terms 
    WHERE (LOWER(term) = :term_b OR LOWER(term) = 'terms_abstract_tfidf__' || :term_b);
    """)

    try:
        with eng.connect() as conn:
            for name, t in (("term_a", clean_a), ("term_b", clean_b)):
                if not term_exists(conn, t):
                    raise HTTPException(status_code=404, detail=f"找不到詞彙 {name}='{t}'。")
            rows = conn.execute(sql, {"term_a": clean_a, "term_b": clean_b}).scalars().all()
        return {
            "term_a": clean_a,
            "term_b": clean_b,
            "count": len(rows),
            "studies": rows
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/dissociate/locations/{coord_1}/{coord_2}")
async def dissociate_locations(coord_1: str, coord_2: str):
    try:
        x1, y1, z1 = parse_coords(coord_1)
        x2, y2, z2 = parse_coords(coord_2)
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))

    eng = get_engine()
    sql = text("""
        SELECT DISTINCT study_id 
        FROM ns.coordinates 
        WHERE ST_X(geom) = :x1 AND ST_Y(geom) = :y1 AND ST_Z(geom) = :z1
        EXCEPT
        SELECT DISTINCT study_id 
        FROM ns.coordinates 
        WHERE ST_X(geom) = :x2 AND ST_Y(geom) = :y2 AND ST_Z(geom) = :z2;
    """)

    try:
        with eng.connect() as conn:
            for name, c in (("coord_1", (x1, y1, z1)), ("coord_2", (x2, y2, z2))):
                if not coord_exists(conn, *c):
                    raise HTTPException(status_code=404, detail=f"資料庫中沒有座標 {name}={list(c)} 的研究。")
            params = {"x1": x1, "y1": y1, "z1": z1, "x2": x2, "y2": y2, "z2": z2}
            rows = conn.execute(sql, params).scalars().all()
        return {
            "coord_1": [x1, y1, z1],
            "coord_2": [x2, y2, z2],
            "count": len(rows),
            "studies": rows
        }
    except HTTPException:  
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/terms/{term:path}/studies")
async def get_studies_by_term(term: str):
    clean_t = clean_term(term)
    require_nonempty("term", clean_t)  
    eng = get_engine()
    sql = text("""
        SELECT DISTINCT study_id 
        FROM ns.annotations_terms 
        WHERE (LOWER(term) = :term OR LOWER(term) = 'terms_abstract_tfidf__' || :term);
    """)
    try:
        with eng.connect() as conn:
            rows = conn.execute(sql, {"term": clean_t}).scalars().all()
        return {"term": clean_t, "count": len(rows), "studies": rows}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/locations/{coords}/studies")
async def get_studies_by_coordinates(coords: str):
    try:
        x, y, z = parse_coords(coords)
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))

    eng = get_engine()
    sql = text("SELECT DISTINCT study_id FROM ns.coordinates WHERE ST_X(geom) = :x AND ST_Y(geom) = :y AND ST_Z(geom) = :z;")
    try:
        with eng.connect() as conn:
            rows = conn.execute(sql, {"x": x, "y": y, "z": z}).scalars().all()
        return {"coords": [x, y, z], "count": len(rows), "studies": rows}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/test_db")
async def test_db():
    eng = get_engine()
    payload = {"ok": False, "dialect": eng.dialect.name}
    try:
        with eng.begin() as conn:
            conn.execute(text("SET search_path TO ns, public;"))
            payload["version"] = conn.exec_driver_sql("SELECT version()").scalar()
            payload["coordinates_count"] = conn.execute(text("SELECT COUNT(*) FROM ns.coordinates")).scalar()
            payload["metadata_count"] = conn.execute(text("SELECT COUNT(*) FROM ns.metadata")).scalar()
            payload["annotations_terms_count"] = conn.execute(text("SELECT COUNT(*) FROM ns.annotations_terms")).scalar()

            try:
                rows = conn.execute(text(
                    "SELECT study_id, ST_X(geom) AS x, ST_Y(geom) AS y, ST_Z(geom) AS z FROM ns.coordinates LIMIT 3"
                )).mappings().all()
                payload["coordinates_sample"] = [dict(r) for r in rows]
            except Exception:
                payload["coordinates_sample"] = []

            try:
                rows = conn.execute(text("SELECT * FROM ns.metadata LIMIT 3")).mappings().all()
                payload["metadata_sample"] = [dict(r) for r in rows]
            except Exception:
                payload["metadata_sample"] = []

            try:
                rows = conn.execute(text(
                    "SELECT study_id, contrast_id, term, weight FROM ns.annotations_terms LIMIT 3"
                )).mappings().all()
                payload["annotations_terms_sample"] = [dict(r) for r in rows]
            except Exception:
                payload["annotations_terms_sample"] = []

        payload["ok"] = True
        return payload
    except Exception as e:
        payload["error"] = str(e)
        return JSONResponse(status_code=500, content=payload)


# -------------------------------------------------------------
# Week 9 LoTUS-BF 核心端點與語法解析器 (Terms, Studies, Locations, NIfTI)
# -------------------------------------------------------------

def _normalize_query(expr: str) -> str:
    if not expr:
        return expr
    expr = re.sub(r'(?i)\b(NOT|AND|OR)(?=[^\s()])', r'\1 ', expr)
    expr = re.sub(r'%(?![0-9A-Fa-f]{2})', ' ', expr)
    expr = re.sub(r'\s+', ' ', expr).strip()
    return expr

_TOKEN_AND = "AND"
_TOKEN_OR = "OR"
_TOKEN_NOT = "NOT"
_TOKEN_RE = re.compile(r'\s*(\(|\)|"(?:\\.|[^"\\])*"|\bAND\b|\bOR\b|\bNOT\b|[^\s()]+)', re.IGNORECASE)

def _build_full_tsquery(expr: str) -> str:
    expr = _normalize_query(expr)
    if not expr:
        return ""
    toks = [m.group(1) for m in _TOKEN_RE.finditer(expr)]
    toks = [t if t in ("(", ")") else (t.upper() if t.upper() in (_TOKEN_AND, _TOKEN_OR, _TOKEN_NOT) else t) for t in toks]
    i = 0

    def starts_term(tok):
        return tok is not None and tok not in (")", _TOKEN_OR)

    def term_tok(tok: str) -> str:
        raw = tok
        quoted = False
        if (raw.startswith('"') and raw.endswith('"')) or (raw.startswith("'") and raw.endswith("'")):
            quoted = True
            raw = raw[1:-1]
        parts = raw.split()
        def norm(p: str) -> str:
            return (p[:-1] + ":*") if p.endswith("*") else p
        if quoted and len(parts) > 1:
            return "(" + " <-> ".join(norm(p) for p in parts) + ")"
        if len(parts) > 1:
            return "(" + " & ".join(norm(p) for p in parts) + ")"
        return norm(parts[0]) if parts else ""

    def parse_primary():
        nonlocal i
        tok = toks[i] if i < len(toks) else None
        if tok is None:
            raise ValueError("Unexpected end of input")
        if tok == "(":
            i += 1
            inner = parse_or()
            if i >= len(toks) or toks[i] != ")":
                raise ValueError("Expected ')'")
            i += 1
            return f"({inner})"
        if tok in (_TOKEN_AND, _TOKEN_OR, _TOKEN_NOT, ")"):
            raise ValueError(f"Unexpected token: {tok}")
        i += 1
        return term_tok(tok)

    def parse_unary():
        nonlocal i
        tok = toks[i] if i < len(toks) else None
        if tok == _TOKEN_NOT:
            i += 1
            op = parse_unary()
            return f"!({op})"
        return parse_primary()

    def parse_and():
        nonlocal i
        left = parse_unary()
        while True:
            tok = toks[i] if i < len(toks) else None
            if tok == _TOKEN_AND:
                i += 1
                right = parse_unary()
                left = f"({left}) & ({right})"
            elif starts_term(tok):
                right = parse_unary()
                left = f"({left}) & ({right})"
            else:
                break
        return left

    def parse_or():
        nonlocal i
        left = parse_and()
        while True:
            tok = toks[i] if i < len(toks) else None
            if tok == _TOKEN_OR:
                i += 1
                right = parse_and()
                left = f"({left}) | ({right})"
            else:
                break
        return left

    return parse_or()

def _parse_location_boolean_expr(qs: str):
    s = unquote(qs).strip()
    token_re = re.compile(r"\[[^\]]+\]|\(|\)|\bAND\b|\bOR\b|\bNOT\b", re.IGNORECASE)
    tokens = token_re.findall(s)
    if not tokens:
        pts = []
        for p in re.findall(r"\[([^\]]+)\]", s):
            parts = [c.strip() for c in p.split(",")]
            if len(parts) == 3:
                pts.append((float(parts[0]), float(parts[1]), float(parts[2])))
        if not pts:
            raise ValueError("No coordinates found. Use [x,y,z].")
        idxs = list(range(1, len(pts) + 1))
        parts = [f"(EXISTS (SELECT 1 FROM hits h WHERE h.study_id = s.study_id AND h.idx = {i}))" for i in idxs]
        return pts, " AND ".join(parts)

    points: List[Tuple[float, float, float]] = []
    point_to_idx: Dict[Tuple[float, float, float], int] = {}

    def parse_point(tok: str) -> int:
        inside = tok.strip()[1:-1]
        parts = [c.strip() for c in inside.split(",")]
        if len(parts) != 3:
            raise ValueError(f"Invalid coordinate triple: {tok}")
        x, y, z = float(parts[0]), float(parts[1]), float(parts[2])
        key = (x, y, z)
        if key not in point_to_idx:
            point_to_idx[key] = len(points) + 1
            points.append(key)
        return point_to_idx[key]

    expr_parts: List[str] = []
    prev_kind: Optional[str] = None
    for tok in tokens:
        up = tok.upper()
        if tok.startswith("["):
            if prev_kind in ("point", ")"):
                expr_parts.append("AND")
            idx = parse_point(tok)
            expr_parts.append(f"(EXISTS (SELECT 1 FROM hits h WHERE h.study_id = s.study_id AND h.idx = {idx}))")
            prev_kind = "point"
        elif up in ("AND", "OR"):
            expr_parts.append(up)
            prev_kind = "op"
        elif up == "NOT":
            if prev_kind in ("point", ")"):
                expr_parts.append("AND")
            expr_parts.append("NOT")
            prev_kind = "op"
        elif tok == "(":
            if prev_kind in ("point", ")"):
                expr_parts.append("AND")
            expr_parts.append("(")
            prev_kind = "("
        elif tok == ")":
            expr_parts.append(")")
            prev_kind = ")"

    expr_sql = " ".join(expr_parts).strip()
    if not expr_sql:
        raise ValueError("Empty boolean expression after parsing.")
    return points, expr_sql

def _split_mixed_query(qs: str):
    s = unquote(qs).strip()
    token_re = re.compile(r"""\[[^\]]+\]|"([^"\\]|\\.)+"|'([^'\\]|\\.)+'|\bAND\b|\bOR\b|\bNOT\b|\(|\)|[^()\s]+""", re.IGNORECASE)
    toks = [m.group(0) for m in re.finditer(token_re, s)]
    loc_parts = []
    prev_was_operand = False
    N = len(toks)

    def _next_is_loc_operand(j):
        k = j
        while k < N:
            t = toks[k]
            up = t.upper()
            if t.startswith('[') and t.endswith(']'):
                return True
            if up in ('(', ')'):
                return up == '('
            if up in ('AND', 'OR'):
                return False
            if up == 'NOT':
                k += 1
                if k < N and (toks[k].startswith('[') and toks[k].endswith(']') or toks[k].upper() == '('):
                    return True
                return False
            k += 1
        return False

    i = 0
    while i < N:
        t = toks[i]
        up = t.upper()
        if t.startswith('[') and t.endswith(']'):
            loc_parts.append(t)
            prev_was_operand = True
        elif up in ('(', ')'):
            loc_parts.append(up)
            prev_was_operand = (up == ')')
        elif up in ('AND', 'OR'):
            if prev_was_operand and _next_is_loc_operand(i + 1):
                loc_parts.append(up)
                prev_was_operand = False
        elif up == 'NOT':
            if _next_is_loc_operand(i + 1):
                if prev_was_operand and (not loc_parts or loc_parts[-1] != 'AND'):
                    loc_parts.append('AND')
                loc_parts.append('NOT')
                prev_was_operand = False
        i += 1
    loc_expr = " ".join(loc_parts).strip() or None

    terms_parts, phrase = [], []
    def flush():
        nonlocal phrase
        if phrase:
            for j, w in enumerate(phrase):
                if j:
                    terms_parts.append('AND')
                terms_parts.append(w)
            phrase = []

    i = 0
    while i < N:
        t = toks[i]
        up = t.upper()
        if t.startswith('[') and t.endswith(']'):
            flush()
            i += 1
            continue
        if up in ('AND', 'OR'):
            if terms_parts:
                flush()
                terms_parts.append(up)
            else:
                flush()
            i += 1
            continue
        if up in ('(', ')'):
            flush()
            i += 1
            continue
        if up == 'NOT':
            nxt = toks[i + 1] if i + 1 < N else None
            if not (nxt and (nxt.startswith('[') and nxt.endswith(']') or (isinstance(nxt, str) and nxt.upper() == '('))):
                flush()
                terms_parts.append('NOT')
            else:
                flush()
            i += 1
            continue
        if (t.startswith('"') and t.endswith('"')) or (t.startswith("'") and t.endswith("'")):
            flush()
            terms_parts.append(t)
        else:
            phrase.append(t)
        i += 1
    flush()
    terms_expr = " ".join(terms_parts).strip() or None

    def _empty(expr: str) -> bool:
        s = expr.replace('(', '').replace(')', '').replace('AND', '').replace('OR', '').replace('NOT', '').strip()
        return s == ''
    if terms_expr is not None and _empty(terms_expr):
        terms_expr = None
    if loc_expr is not None and _empty(loc_expr):
        loc_expr = None
    return terms_expr, loc_expr

def _collect_coords_for_mixed(conn, query_string: str, r: float):
    terms_expr, loc_expr = _split_mixed_query(query_string)
    ctes, params = [], {}
    if terms_expr:
        ts_full = _build_full_tsquery(terms_expr)
        ctes.append("""
        matched_terms AS (
          SELECT m.study_id
          FROM ns.metadata m
          WHERE (
            m.fts @@ to_tsquery('english', :full_tsquery)
            OR to_tsvector('english', COALESCE(m.title,'')) @@ to_tsquery('english', :full_tsquery)
          )
        )
        """)
        params['full_tsquery'] = ts_full
    if loc_expr:
        points, loc_sql = _parse_location_boolean_expr(loc_expr)
        pts_rows = "\nUNION ALL\n".join([f"SELECT {i+1} AS idx, ST_MakePoint({x},{y},{z}) AS geom" for i, (x, y, z) in enumerate(points)])
        ctes.append(f"""
        pts AS ( {pts_rows} ),
        hits AS (
          SELECT c.study_id, p.idx
          FROM ns.coordinates c
          JOIN pts p
            ON ST_3DDistance(ST_SetSRID(c.geom,0), ST_SetSRID(p.geom,0)) < :r
          GROUP BY c.study_id, p.idx
        ),
        studies AS ( SELECT DISTINCT study_id FROM ns.coordinates ),
        matched_loc AS ( SELECT s.study_id FROM studies s WHERE {loc_sql} )
        """)
        params["r"] = r
    if loc_expr and terms_expr:
        matched_select = "SELECT study_id FROM matched_loc INTERSECT SELECT study_id FROM matched_terms"
    elif loc_expr:
        matched_select = "SELECT study_id FROM matched_loc"
    elif terms_expr:
        matched_select = "SELECT study_id FROM matched_terms"
    else:
        raise ValueError("Query must contain at least a term or a [x,y,z] coordinate.")

    ctes_sql = ",\n".join([c.strip() for c in ctes])
    sql = text(f"""
        WITH
        {ctes_sql},
        matched AS ( {matched_select} )
        SELECT c.study_id,
               ST_X(c.geom)::float AS x,
               ST_Y(c.geom)::float AS y,
               ST_Z(c.geom)::float AS z
        FROM ns.coordinates c
        JOIN matched x USING (study_id)
    """)
    rows = conn.execute(sql, params).mappings().all()
    out = {}
    for r_ in rows:
        out.setdefault(r_["study_id"], []).append((r_["x"], r_["y"], r_["z"]))
    return out

def _make_nii_from_coords(coords_by_study, voxel: float = 2.0, fwhm: float = 10.0, kernel: str = "gauss"):
    try:
        import nibabel as nib
    except Exception as e:
        raise RuntimeError("nibabel is required to build NIfTI: " + str(e))
    try:
        from scipy.ndimage import gaussian_filter
        has_scipy = True
    except Exception:
        has_scipy = False

    shape = (91, 109, 91)
    zooms = (2.0, 2.0, 2.0)
    template_aff = np.array([
        [-2.0, 0.0, 0.0, 90.0],
        [0.0, 2.0, 0.0, -126.0],
        [0.0, 0.0, 2.0, -72.0],
        [0.0, 0.0, 0.0, 1.0]
    ], dtype=float)

    vol = np.zeros(shape, dtype=np.float32)
    inv_aff = np.linalg.inv(template_aff)

    n = 0
    for sid, pts in coords_by_study.items():
        for (x, y, z) in pts:
            ijk_h = inv_aff @ np.array([float(x), float(y), float(z), 1.0], dtype=np.float64)
            i, j, k = np.round(ijk_h[:3]).astype(int)
            if 0 <= i < shape[0] and 0 <= j < shape[1] and 0 <= k < shape[2]:
                vol[i, j, k] += 1.0
                n += 1

    if has_scipy and kernel.lower() == "gauss" and fwhm and fwhm > 0:
        denom = 2.0 * np.sqrt(2.0 * np.log(2.0))
        sigma_vox = tuple((fwhm / denom) / max(1e-6, z) for z in zooms)
        vol = gaussian_filter(vol, sigma=sigma_vox, mode="constant", truncate=3.0)

    out_img = nib.Nifti1Image(vol, template_aff)
    out_img.set_data_dtype(np.float32)
    hdr = out_img.header
    hdr.set_data_shape(shape)
    hdr.set_xyzt_units('mm', 'sec')
    hdr.set_zooms(zooms)

    out_img.set_sform(template_aff, code=4)
    out_img.set_qform(template_aff, code=4)
    hdr['srow_x'] = template_aff[0]
    hdr['srow_y'] = template_aff[1]
    hdr['srow_z'] = template_aff[2]

    outdir = tempfile.mkdtemp(prefix="lotus_nii_")
    outpath = os.path.join(outdir, "query_mixed_map.nii.gz")
    nib.save(out_img, outpath)
    return outpath, n


# -------------------------------------------------------------
# 前端主端點 (Terms, Query Studies, Query Locations, Query Nii)
# -------------------------------------------------------------

@app.get("/terms")
async def get_terms():
    """回傳所有可用詞彙 (去除前綴並去重)"""
    eng = get_engine()
    terms_list = []
    try:
        with eng.connect() as conn:
            conn.execute(text("SET search_path TO ns, public;"))
            try:
                sql = text("""
                    SELECT DISTINCT
                      CASE WHEN LOWER(term) LIKE 'terms_abstract_tfidf__%'
                           THEN SUBSTRING(LOWER(term) FROM 25)
                           ELSE LOWER(term)
                      END AS clean_term
                    FROM ns.annotations_terms
                    WHERE term IS NOT NULL
                    ORDER BY clean_term
                    LIMIT 3000;
                """)
                rows = conn.execute(sql).fetchall()
                terms_list = [r[0] for r in rows if r[0] and not re.match(r'^\d', r[0])]
            except Exception:
                sql = text("""
                    SELECT DISTINCT
                      CASE WHEN key LIKE 'terms_abstract_tfidf__%'
                           THEN SUBSTRING(key FROM 25)
                           ELSE key
                      END AS term
                    FROM (
                      SELECT jsonb_object_keys(terms) AS key
                      FROM ns.annotations_json
                    ) j
                    ORDER BY term
                    LIMIT 3000;
                """)
                rows = conn.execute(sql).fetchall()
                terms_list = [r[0] for r in rows if r[0] and not re.match(r'^\d', r[0])]
        return {"terms": terms_list}
    except Exception as e:
        return {"terms": [], "error": str(e)}

@app.get("/query/{query_string:path}/studies")
async def query_studies(
    query_string: str,
    r: float = 6.0,
    limit: Optional[int] = None,
    offset: int = 0
):
    terms_expr, loc_expr = _split_mixed_query(query_string)
    has_terms, has_loc = terms_expr is not None, loc_expr is not None
    if not (has_terms or has_loc):
        raise HTTPException(status_code=400, detail="Query must include at least a term or a [x,y,z] coordinate.")

    eng = get_engine()
    try:
        with eng.begin() as conn:
            conn.execute(text("SET search_path TO ns, public;"))
            ctes, params = [], {}

            if has_terms:
                ts_full = _build_full_tsquery(terms_expr)
                ctes.append("""
                matched_terms AS (
                  SELECT m.study_id
                  FROM ns.metadata m
                  WHERE (
                    m.fts @@ to_tsquery('english', :full_tsquery)
                    OR to_tsvector('english', COALESCE(m.title,'')) @@ to_tsquery('english', :full_tsquery)
                  )
                )""")
                params['full_tsquery'] = ts_full

            if has_loc:
                points, loc_sql = _parse_location_boolean_expr(loc_expr)
                pts_rows = "\nUNION ALL\n".join([f"SELECT {i+1} AS idx, ST_MakePoint({x}, {y}, {z}) AS geom" for i, (x, y, z) in enumerate(points)])
                ctes.append(f"""
                pts AS ( {pts_rows} ),
                hits AS (
                  SELECT c.study_id, p.idx
                  FROM ns.coordinates c
                  JOIN pts p
                    ON ST_3DDistance(ST_SetSRID(c.geom,0), ST_SetSRID(p.geom,0)) < :r
                  GROUP BY c.study_id, p.idx
                ),
                studies AS ( SELECT DISTINCT study_id FROM ns.coordinates ),
                matched_loc AS ( SELECT s.study_id FROM studies s WHERE {loc_sql} )
                """)
                params["r"] = r

            if has_loc and has_terms:
                matched_select = "SELECT study_id FROM matched_loc INTERSECT SELECT study_id FROM matched_terms"
            elif has_loc:
                matched_select = "SELECT study_id FROM matched_loc"
            else:
                matched_select = "SELECT study_id FROM matched_terms"

            ctes_sql = ",\n".join([c.strip() for c in ctes])
            with_matched = f"WITH {ctes_sql},\nmatched AS ( {matched_select} )"

            limit_clause = ""
            lp = {}
            if limit is not None:
                limit_clause = "LIMIT :limit"
                lp["limit"] = max(1, min(limit, 10000))
                if offset:
                    limit_clause += " OFFSET :offset"
                    lp["offset"] = max(0, offset)
            elif offset:
                limit_clause = "OFFSET :offset"
                lp["offset"] = max(0, offset)

            sql = text(f"""
                {with_matched}
                SELECT m.*
                FROM ns.metadata m
                JOIN matched x USING (study_id)
                ORDER BY m.year DESC NULLS LAST, m.study_id ASC
                {limit_clause}
            """)
            rows = conn.execute(sql, {**params, **lp}).mappings().all()
            out = []
            for r_ in rows:
                d = dict(r_)
                d.pop('fts', None)
                out.append(d)
            return {
                "count": len(out),
                "applied": {
                    "locations": bool(has_loc),
                    "terms": bool(has_terms),
                    "r": r if has_loc else None
                },
                "results": out
            }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/query/{query_string:path}/locations")
async def query_locations(
    query_string: str,
    r: float = 6.0,
    limit: Optional[int] = None,
    offset: int = 0
):
    eng = get_engine()
    try:
        with eng.begin() as conn:
            conn.execute(text("SET search_path TO ns, public;"))
            coords_by_study = _collect_coords_for_mixed(conn, query_string, r=r)
            rows = []
            for sid, coords in coords_by_study.items():
                for (x, y, z) in coords:
                    rows.append({"study_id": sid, "x": x, "y": y, "z": z})
            rows.sort(key=lambda d: (d["study_id"], d["x"], d["y"], d["z"]))
            if offset:
                rows = rows[offset:]
            if limit is not None:
                rows = rows[:limit]
            return {
                "location_counts": len(rows),
                "study_counts": len({d['study_id'] for d in rows}),
                "results": rows
            }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.get("/query/{query_string:path}/nii")
async def query_nii(
    query_string: str,
    voxel: float = 2.0,
    fwhm: float = 10.0,
    kernel: str = "gauss",
    r: float = 6.0
):
    eng = get_engine()
    try:
        with eng.begin() as conn:
            conn.execute(text("SET search_path TO ns, public;"))
            coords_by_study = _collect_coords_for_mixed(conn, query_string, r=r)
            path, n = _make_nii_from_coords(coords_by_study, voxel=voxel, fwhm=fwhm, kernel=kernel)
            return FileResponse(
                path,
                filename="query_mixed_map.nii.gz",
                media_type="application/octet-stream"
            )
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


# -------------------------------------------------------------
# 靜態檔案與前端 Single-Page Application (SPA) 掛載
# -------------------------------------------------------------

base_dir = os.path.dirname(__file__)
dist_dir = os.path.join(base_dir, "dist")
public_static_dir = os.path.join(base_dir, "public", "static")

# 若有 public/static (例如本機開發環境)，提供 /static 下載
if os.path.exists(public_static_dir):
    app.mount("/static", StaticFiles(directory=public_static_dir), name="public_static")

# 若已建置前端 dist 目錄，直接作為 SPA 掛載於根目錄
if os.path.exists(dist_dir):
    app.mount("/", StaticFiles(directory=dist_dir, html=True), name="frontend")
else:
    @app.get("/", response_class=HTMLResponse)
    async def health():
        return "<p>Server working! (Frontend dist not built yet. Run 'npm run build' to bundle the frontend.)</p>"


# -------------------------------------------------------------
# 本機開發啟動區塊
# -------------------------------------------------------------
if __name__ == "__main__":
    uvicorn.run(
        "app:app",  
        host="127.0.0.1",
        port=5000,
        reload=True,
    )
