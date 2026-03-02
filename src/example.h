#ifndef LAYOUT_H
#define LAYOUT_H

#if defined(_MSC_VER)
typedef signed __int32 layout_i32;
#else
typedef __INT32_TYPE__ layout_i32;
#endif

#if defined(__wasm__)
#define LAYOUT_EXPORT(name) __attribute__((export_name(name)))
#else
#define LAYOUT_EXPORT(name)
#endif

/* ── Constants ─────────────────────────────────────────────────────── */

#define MAX_PANELS 16                /* max area slots                  */
#define MAX_HANDLES (MAX_PANELS - 1) /* max handle slots                */

/* ── Error codes (returned by every API call) ──────────────────────── */

enum layout_error {
  LAYOUT_OK = 0,
  LAYOUT_ERR_NOT_INITIALIZED = 1,
  LAYOUT_ERR_INVALID_ARG = 2,
  LAYOUT_ERR_INVALID_HANDLE = 3,
  LAYOUT_ERR_INVALID_AREA = 4,
  LAYOUT_ERR_INVALID_CORNER = 5,
  LAYOUT_ERR_OUT_OF_BOUNDS = 6,
  LAYOUT_ERR_MIN_SIZE = 7,
  LAYOUT_ERR_NOT_IMPLEMENTED = 8,
  LAYOUT_ERR_CAPACITY = 9,
};

/* ── Public data structures ────────────────────────────────────────── */

/* Axis-aligned rectangle + opaque content tag. */
typedef struct {
  layout_i32 x0, y0, x1, y1; /* bounding box (pixels)           */
  layout_i32 content_id;     /* user-assigned content tag       */
} LayoutArea;

typedef struct {
  layout_i32 x0, y0, x1, y1; /* bounding box (pixels)           */
  layout_i32 content_id;     /* user-assigned content tag       */
} LayoutHandle;

/* Flat struct returned by get_info_ptr(). Read from shared memory.    */
typedef struct {
  layout_i32 initialized;            /* 1 after successful init         */
  layout_i32 screen_w;               /* current screen width            */
  layout_i32 screen_h;               /* current screen height           */
  layout_i32 max_panels;             /* == MAX_PANELS                   */
  layout_i32 max_handles;            /* == MAX_HANDLES                  */
  layout_i32 area_count;             /* active area count               */
  layout_i32 handle_count;           /* active handle count             */
  layout_i32 last_error;             /* error code of last call         */
  layout_i32 generation;             /* bumped on every mutation        */
  layout_i32 last_action;            /* action id of last mutation      */
  layout_i32 last_index;             /* index arg of last mutation      */
  layout_i32 last_x;                 /* x arg of last mutation          */
  layout_i32 last_y;                 /* y arg of last mutation          */
  layout_i32 handle_half_size;       /* half-size used for handles      */
  layout_i32 min_panel_size;         /* smallest allowed area dimension */
  LayoutArea areas[MAX_PANELS];      /* area slots                      */
  LayoutHandle handles[MAX_HANDLES]; /* handle slots                    */
  layout_i32 try_valid;              /* 1 when try_corner preview valid */
  layout_i32 try_x0;                 /* preview rect x0                 */
  layout_i32 try_y0;                 /* preview rect y0                 */
  layout_i32 try_x1;                 /* preview rect x1                 */
  layout_i32 try_y1;                 /* preview rect y1                 */
} LayoutInfo;

/* ── API ───────────────────────────────────────────────────────────── */

/* Initialize layout with one full-screen area. Resets all state.      */
LAYOUT_EXPORT("init_screen")
layout_i32 init_screen(layout_i32 w, layout_i32 h, layout_i32 handle_size,
                       layout_i32 min_panel_size);

/* Resize screen, proportionally rescaling all areas and handles.      */
LAYOUT_EXPORT("resize_screen")
layout_i32 resize_screen(layout_i32 w, layout_i32 h, layout_i32 handle_size);

/* Move a split handle to (x,y), resizing adjacent areas.              */
LAYOUT_EXPORT("move_handle")
layout_i32 move_handle(layout_i32 handle_index, layout_i32 x, layout_i32 y);

/* Drag a corner of an area to (x,y) to split or merge.               */
LAYOUT_EXPORT("move_corner")
layout_i32 move_corner(layout_i32 area_index, layout_i32 corner_index,
                       layout_i32 x, layout_i32 y);

/* Compute preview rect for corner drag (non-mutating).                */
LAYOUT_EXPORT("try_corner")
layout_i32 try_corner(layout_i32 area_index, layout_i32 corner_index,
                      layout_i32 x, layout_i32 y);

/* Assign a content tag to an area.                                    */
LAYOUT_EXPORT("set_area_content")
layout_i32 set_area_content(layout_i32 area_index, layout_i32 content_id);

/* Assign a content tag to a handle.                                   */
LAYOUT_EXPORT("set_handle_content")
layout_i32 set_handle_content(layout_i32 handle_index, layout_i32 content_id);

/* Returns pointer to the LayoutInfo struct in shared memory.          */
LAYOUT_EXPORT("get_info_ptr")
layout_i32 get_info_ptr(void);

#undef LAYOUT_EXPORT

#endif /* LAYOUT_H */
/*
+---+---+---+
| A | B | C |
+---+---+---+
|     D     +
+-----------+


+----+----+----+
| A  | B  |  C |
+----+    -----+
| D2 |    | D1 |
+--------------+
*/
