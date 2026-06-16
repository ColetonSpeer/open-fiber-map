--
-- PostgreSQL database dump
--

\restrict JVCjzkcnEf525G6My9HTLu2gSOw6bQ7RUAstLbTAXDnRCqutayMfBCIcYr3vSRF

-- Dumped from database version 16.13 (Ubuntu 16.13-0ubuntu0.24.04.1)
-- Dumped by pg_dump version 16.13 (Ubuntu 16.13-0ubuntu0.24.04.1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'SQL_ASCII';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: postgis; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA public;


--
-- Name: EXTENSION postgis; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION postgis IS 'PostGIS geometry and geography spatial types and functions';


--
-- Name: notify_map_change(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_map_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM pg_notify('map_changes', json_build_object(
    'table', TG_TABLE_NAME,
    'action', TG_OP,
    'id', COALESCE(NEW.id, OLD.id)
  )::text);
  RETURN COALESCE(NEW, OLD);
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: cables; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cables (
    id integer NOT NULL,
    closure_id integer,
    route_id integer,
    name character varying(50) NOT NULL,
    fiber_count integer NOT NULL,
    direction character varying(3),
    notes text,
    created_at timestamp without time zone DEFAULT now(),
    link_closure_id integer,
    CONSTRAINT cables_direction_check CHECK (((direction)::text = ANY ((ARRAY['IN'::character varying, 'OUT'::character varying])::text[])))
);


--
-- Name: cables_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.cables_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: cables_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.cables_id_seq OWNED BY public.cables.id;


--
-- Name: card_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.card_types (
    id integer NOT NULL,
    name character varying(100) NOT NULL,
    port_groups jsonb NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: card_types_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.card_types_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: card_types_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.card_types_id_seq OWNED BY public.card_types.id;


--
-- Name: closures; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.closures (
    id integer NOT NULL,
    name character varying(50) NOT NULL,
    notes text,
    geom public.geometry(Point,4326) NOT NULL,
    created_by integer,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    pole_id integer,
    layer_id integer
);


--
-- Name: closures_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.closures_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: closures_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.closures_id_seq OWNED BY public.closures.id;


--
-- Name: connections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.connections (
    id integer NOT NULL,
    a_port_id integer,
    a_panel_fiber_id integer,
    a_strand integer,
    b_port_id integer,
    b_panel_fiber_id integer,
    b_strand integer,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    pair_id integer,
    CONSTRAINT check_side_a CHECK (((((a_port_id IS NOT NULL))::integer + ((a_panel_fiber_id IS NOT NULL))::integer) = 1)),
    CONSTRAINT check_side_b CHECK (((((b_port_id IS NOT NULL))::integer + ((b_panel_fiber_id IS NOT NULL))::integer) = 1)),
    CONSTRAINT check_strand_a CHECK (((a_panel_fiber_id IS NULL) OR (a_strand IS NOT NULL))),
    CONSTRAINT check_strand_b CHECK (((b_panel_fiber_id IS NULL) OR (b_strand IS NOT NULL)))
);


--
-- Name: connections_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.connections_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: connections_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.connections_id_seq OWNED BY public.connections.id;


--
-- Name: connector_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.connector_types (
    name character varying(20) NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    sort_order smallint DEFAULT 0 NOT NULL
);

INSERT INTO public.connector_types (name, enabled, sort_order) VALUES
  ('LC/UPC Simplex', true, 1),
  ('LC/UPC Duplex',  true, 2),
  ('LC/APC',         true, 3),
  ('SC/UPC',         true, 4),
  ('SC/APC',         true, 5),
  ('MPO-12',         true, 6),
  ('FC/UPC',         true, 7),
  ('FC/APC',         true, 8),
  ('ST/UPC',         true, 9)
ON CONFLICT (name) DO NOTHING;


--
-- Name: custom_field_defs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.custom_field_defs (
    id integer NOT NULL,
    entity_type character varying(20) NOT NULL,
    field_label character varying(100) NOT NULL,
    field_type character varying(20) DEFAULT 'text'::character varying NOT NULL,
    options text[],
    sort_order integer DEFAULT 0,
    created_at timestamp without time zone DEFAULT now(),
    show_on_create boolean DEFAULT false
);


--
-- Name: custom_field_defs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.custom_field_defs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: custom_field_defs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.custom_field_defs_id_seq OWNED BY public.custom_field_defs.id;


--
-- Name: custom_field_values; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.custom_field_values (
    id integer NOT NULL,
    field_def_id integer,
    entity_type character varying(20) NOT NULL,
    entity_id integer NOT NULL,
    value text
);


--
-- Name: custom_field_values_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.custom_field_values_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: custom_field_values_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.custom_field_values_id_seq OWNED BY public.custom_field_values.id;


--
-- Name: equipment; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.equipment (
    id integer NOT NULL,
    site_id integer NOT NULL,
    name character varying(100) NOT NULL,
    equipment_type character varying(20) NOT NULL,
    model character varying(100),
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    template_id integer,
    port_prefix character varying(30) DEFAULT ''::character varying NOT NULL
);


--
-- Name: equipment_card_assignments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.equipment_card_assignments (
    id integer NOT NULL,
    equipment_id integer NOT NULL,
    card_slot integer NOT NULL,
    card_type_id integer NOT NULL
);


--
-- Name: equipment_card_assignments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.equipment_card_assignments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: equipment_card_assignments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.equipment_card_assignments_id_seq OWNED BY public.equipment_card_assignments.id;


--
-- Name: equipment_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.equipment_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: equipment_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.equipment_id_seq OWNED BY public.equipment.id;


--
-- Name: equipment_ports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.equipment_ports (
    id integer NOT NULL,
    equipment_id integer NOT NULL,
    port_label character varying(50) NOT NULL,
    connector_type character varying(20),
    port_order integer DEFAULT 0 NOT NULL,
    slot_number integer,
    sfp_assignment_id integer,
    port_type character varying(20),
    port_group_id character varying(40),
    card_slot integer,
    is_shared_fiber boolean DEFAULT false NOT NULL
);


--
-- Name: equipment_ports_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.equipment_ports_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: equipment_ports_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.equipment_ports_id_seq OWNED BY public.equipment_ports.id;


--
-- Name: equipment_sfp_assignments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.equipment_sfp_assignments (
    id integer NOT NULL,
    equipment_id integer NOT NULL,
    slot_number integer NOT NULL,
    sfp_type_id integer NOT NULL,
    port_group_id character varying(40) DEFAULT 'default'::character varying NOT NULL,
    card_slot integer DEFAULT 0 NOT NULL
);


--
-- Name: equipment_sfp_assignments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.equipment_sfp_assignments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: equipment_sfp_assignments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.equipment_sfp_assignments_id_seq OWNED BY public.equipment_sfp_assignments.id;


--
-- Name: equipment_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.equipment_templates (
    id integer NOT NULL,
    name character varying(100) NOT NULL,
    equipment_type character varying(20) NOT NULL,
    fixed_port_count integer,
    fixed_port_prefix character varying(30),
    fixed_port_type character varying(20) DEFAULT 'optical'::character varying,
    fixed_connector_type character varying(20),
    sfp_slot_count integer,
    sfp_slot_prefix character varying(30) DEFAULT 'Card'::character varying,
    created_at timestamp with time zone DEFAULT now(),
    port_groups jsonb,
    card_slot_count integer,
    card_slot_prefix_pattern character varying(30)
);


--
-- Name: equipment_templates_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.equipment_templates_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: equipment_templates_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.equipment_templates_id_seq OWNED BY public.equipment_templates.id;


--
-- Name: layer_groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.layer_groups (
    id integer NOT NULL,
    name text NOT NULL,
    visible boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: layer_groups_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.layer_groups_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: layer_groups_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.layer_groups_id_seq OWNED BY public.layer_groups.id;


--
-- Name: layers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.layers (
    id integer NOT NULL,
    group_id integer NOT NULL,
    name text NOT NULL,
    visible boolean DEFAULT true NOT NULL,
    allowed_types text[] DEFAULT '{}'::text[] NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: layers_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.layers_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: layers_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.layers_id_seq OWNED BY public.layers.id;


--
-- Name: panel_fiber_strands; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.panel_fiber_strands (
    id integer NOT NULL,
    panel_fiber_id integer NOT NULL,
    strand_number integer NOT NULL,
    connector character varying(20) NOT NULL,
    CONSTRAINT panel_fiber_strands_strand_number_check CHECK ((strand_number >= 1))
);


--
-- Name: panel_fiber_strands_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.panel_fiber_strands_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: panel_fiber_strands_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.panel_fiber_strands_id_seq OWNED BY public.panel_fiber_strands.id;


--
-- Name: panel_fibers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.panel_fibers (
    id integer NOT NULL,
    panel_id integer NOT NULL,
    route_id integer NOT NULL,
    connector character varying(20)
);


--
-- Name: panel_fibers_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.panel_fibers_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: panel_fibers_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.panel_fibers_id_seq OWNED BY public.panel_fibers.id;


--
-- Name: patch_panels; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.patch_panels (
    id integer NOT NULL,
    site_id integer NOT NULL,
    name character varying(100) NOT NULL,
    default_connector character varying(20) DEFAULT 'LC/UPC'::character varying NOT NULL,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: patch_panels_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.patch_panels_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: patch_panels_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.patch_panels_id_seq OWNED BY public.patch_panels.id;


--
-- Name: poles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.poles (
    id integer NOT NULL,
    name character varying(50) NOT NULL,
    notes text,
    geom public.geometry(Point,4326) NOT NULL,
    created_by integer,
    created_at timestamp without time zone DEFAULT now(),
    layer_id integer,
    is_plan boolean DEFAULT false
);


--
-- Name: poles_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.poles_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: poles_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.poles_id_seq OWNED BY public.poles.id;


--
-- Name: routes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.routes (
    id integer NOT NULL,
    name character varying(50) NOT NULL,
    notes text,
    geom public.geometry(LineString,4326) NOT NULL,
    created_by integer,
    created_at timestamp without time zone DEFAULT now(),
    color character varying(20) DEFAULT '#FF8800'::character varying,
    attached_poles integer[] DEFAULT '{}'::integer[],
    fiber_count integer DEFAULT 12,
    attached_sites integer[] DEFAULT '{}'::integer[],
    layer_id integer,
    is_plan boolean DEFAULT false
);


--
-- Name: routes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.routes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: routes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.routes_id_seq OWNED BY public.routes.id;


--
-- Name: session; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.session (
    sid character varying NOT NULL,
    sess json NOT NULL,
    expire timestamp(6) without time zone NOT NULL
);


--
-- Name: sfp_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sfp_types (
    id integer NOT NULL,
    name character varying(100) NOT NULL,
    port_configs jsonb DEFAULT '[]'::jsonb NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    compatible_port_types jsonb DEFAULT '[]'::jsonb NOT NULL
);


--
-- Name: sfp_types_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sfp_types_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sfp_types_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sfp_types_id_seq OWNED BY public.sfp_types.id;


--
-- Name: sites; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sites (
    id integer NOT NULL,
    name text NOT NULL,
    site_type text NOT NULL,
    notes text,
    geom public.geometry(Point,4326) NOT NULL,
    created_by integer,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    layer_id integer,
    CONSTRAINT sites_site_type_check CHECK ((site_type = ANY (ARRAY['office'::text, 'pole_cabinet'::text, 'ground_cabinet'::text, 'hut'::text])))
);


--
-- Name: sites_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sites_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sites_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sites_id_seq OWNED BY public.sites.id;


--
-- Name: splices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.splices (
    id integer NOT NULL,
    closure_id integer,
    from_cable_id integer,
    from_fiber integer NOT NULL,
    to_cable_id integer,
    to_fiber integer NOT NULL,
    splice_type character varying(20) DEFAULT 'fusion'::character varying,
    notes text,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: splices_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.splices_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: splices_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.splices_id_seq OWNED BY public.splices.id;


--
-- Name: splitters; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.splitters (
    id integer NOT NULL,
    closure_id integer,
    name character varying(50) NOT NULL,
    ratio character varying(10) NOT NULL,
    input_cable_id integer,
    input_fiber integer,
    output_cable_id integer,
    notes text,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: splitters_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.splitters_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: splitters_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.splitters_id_seq OWNED BY public.splitters.id;


--
-- Name: entity_photos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.entity_photos (
    id integer NOT NULL,
    entity_type character varying(20) NOT NULL,
    entity_id integer NOT NULL,
    url text NOT NULL,
    caption character varying(255),
    created_at timestamp with time zone DEFAULT now()
);

CREATE SEQUENCE public.entity_photos_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.entity_photos_id_seq OWNED BY public.entity_photos.id;
ALTER TABLE ONLY public.entity_photos ALTER COLUMN id SET DEFAULT nextval('public.entity_photos_id_seq'::regclass);
ALTER TABLE ONLY public.entity_photos ADD CONSTRAINT entity_photos_pkey PRIMARY KEY (id);
CREATE INDEX idx_entity_photos ON public.entity_photos USING btree (entity_type, entity_id);


--
-- Name: user_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_preferences (
    user_id integer NOT NULL,
    prefs jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id integer NOT NULL,
    username character varying(50) NOT NULL,
    password_hash character varying(255) NOT NULL,
    full_name character varying(100),
    role character varying(20) DEFAULT 'user'::character varying,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: users_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.users_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: users_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.users_id_seq OWNED BY public.users.id;


--
-- Name: cables id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cables ALTER COLUMN id SET DEFAULT nextval('public.cables_id_seq'::regclass);


--
-- Name: card_types id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.card_types ALTER COLUMN id SET DEFAULT nextval('public.card_types_id_seq'::regclass);


--
-- Name: closures id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.closures ALTER COLUMN id SET DEFAULT nextval('public.closures_id_seq'::regclass);


--
-- Name: connections id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connections ALTER COLUMN id SET DEFAULT nextval('public.connections_id_seq'::regclass);


--
-- Name: custom_field_defs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custom_field_defs ALTER COLUMN id SET DEFAULT nextval('public.custom_field_defs_id_seq'::regclass);


--
-- Name: custom_field_values id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custom_field_values ALTER COLUMN id SET DEFAULT nextval('public.custom_field_values_id_seq'::regclass);


--
-- Name: equipment id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipment ALTER COLUMN id SET DEFAULT nextval('public.equipment_id_seq'::regclass);


--
-- Name: equipment_card_assignments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipment_card_assignments ALTER COLUMN id SET DEFAULT nextval('public.equipment_card_assignments_id_seq'::regclass);


--
-- Name: equipment_ports id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipment_ports ALTER COLUMN id SET DEFAULT nextval('public.equipment_ports_id_seq'::regclass);


--
-- Name: equipment_sfp_assignments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipment_sfp_assignments ALTER COLUMN id SET DEFAULT nextval('public.equipment_sfp_assignments_id_seq'::regclass);


--
-- Name: equipment_templates id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipment_templates ALTER COLUMN id SET DEFAULT nextval('public.equipment_templates_id_seq'::regclass);


--
-- Name: layer_groups id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.layer_groups ALTER COLUMN id SET DEFAULT nextval('public.layer_groups_id_seq'::regclass);


--
-- Name: layers id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.layers ALTER COLUMN id SET DEFAULT nextval('public.layers_id_seq'::regclass);


--
-- Name: panel_fiber_strands id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.panel_fiber_strands ALTER COLUMN id SET DEFAULT nextval('public.panel_fiber_strands_id_seq'::regclass);


--
-- Name: panel_fibers id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.panel_fibers ALTER COLUMN id SET DEFAULT nextval('public.panel_fibers_id_seq'::regclass);


--
-- Name: patch_panels id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patch_panels ALTER COLUMN id SET DEFAULT nextval('public.patch_panels_id_seq'::regclass);


--
-- Name: poles id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.poles ALTER COLUMN id SET DEFAULT nextval('public.poles_id_seq'::regclass);


--
-- Name: routes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.routes ALTER COLUMN id SET DEFAULT nextval('public.routes_id_seq'::regclass);


--
-- Name: sfp_types id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sfp_types ALTER COLUMN id SET DEFAULT nextval('public.sfp_types_id_seq'::regclass);


--
-- Name: sites id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sites ALTER COLUMN id SET DEFAULT nextval('public.sites_id_seq'::regclass);


--
-- Name: splices id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.splices ALTER COLUMN id SET DEFAULT nextval('public.splices_id_seq'::regclass);


--
-- Name: splitters id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.splitters ALTER COLUMN id SET DEFAULT nextval('public.splitters_id_seq'::regclass);


--
-- Name: users id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users ALTER COLUMN id SET DEFAULT nextval('public.users_id_seq'::regclass);


--
-- Name: cables cables_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cables
    ADD CONSTRAINT cables_pkey PRIMARY KEY (id);


--
-- Name: card_types card_types_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.card_types
    ADD CONSTRAINT card_types_name_key UNIQUE (name);


--
-- Name: card_types card_types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.card_types
    ADD CONSTRAINT card_types_pkey PRIMARY KEY (id);


--
-- Name: closures closures_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.closures
    ADD CONSTRAINT closures_pkey PRIMARY KEY (id);


--
-- Name: connections connections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connections
    ADD CONSTRAINT connections_pkey PRIMARY KEY (id);


--
-- Name: connector_types connector_types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connector_types
    ADD CONSTRAINT connector_types_pkey PRIMARY KEY (name);


--
-- Name: custom_field_defs custom_field_defs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custom_field_defs
    ADD CONSTRAINT custom_field_defs_pkey PRIMARY KEY (id);


--
-- Name: custom_field_values custom_field_values_field_def_id_entity_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custom_field_values
    ADD CONSTRAINT custom_field_values_field_def_id_entity_id_key UNIQUE (field_def_id, entity_id);


--
-- Name: custom_field_values custom_field_values_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custom_field_values
    ADD CONSTRAINT custom_field_values_pkey PRIMARY KEY (id);


--
-- Name: equipment_card_assignments equipment_card_assignments_equipment_id_card_slot_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipment_card_assignments
    ADD CONSTRAINT equipment_card_assignments_equipment_id_card_slot_key UNIQUE (equipment_id, card_slot);


--
-- Name: equipment_card_assignments equipment_card_assignments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipment_card_assignments
    ADD CONSTRAINT equipment_card_assignments_pkey PRIMARY KEY (id);


--
-- Name: equipment equipment_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipment
    ADD CONSTRAINT equipment_pkey PRIMARY KEY (id);


--
-- Name: equipment_ports equipment_ports_equipment_id_port_label_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipment_ports
    ADD CONSTRAINT equipment_ports_equipment_id_port_label_key UNIQUE (equipment_id, port_label);


--
-- Name: equipment_ports equipment_ports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipment_ports
    ADD CONSTRAINT equipment_ports_pkey PRIMARY KEY (id);


--
-- Name: equipment_sfp_assignments equipment_sfp_assignments_equip_card_group_slot_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipment_sfp_assignments
    ADD CONSTRAINT equipment_sfp_assignments_equip_card_group_slot_key UNIQUE (equipment_id, card_slot, port_group_id, slot_number);


--
-- Name: equipment_sfp_assignments equipment_sfp_assignments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipment_sfp_assignments
    ADD CONSTRAINT equipment_sfp_assignments_pkey PRIMARY KEY (id);


--
-- Name: equipment_templates equipment_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipment_templates
    ADD CONSTRAINT equipment_templates_pkey PRIMARY KEY (id);


--
-- Name: layer_groups layer_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.layer_groups
    ADD CONSTRAINT layer_groups_pkey PRIMARY KEY (id);


--
-- Name: layers layers_group_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.layers
    ADD CONSTRAINT layers_group_id_name_key UNIQUE (group_id, name);


--
-- Name: layers layers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.layers
    ADD CONSTRAINT layers_pkey PRIMARY KEY (id);


--
-- Name: panel_fiber_strands panel_fiber_strands_panel_fiber_id_strand_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.panel_fiber_strands
    ADD CONSTRAINT panel_fiber_strands_panel_fiber_id_strand_number_key UNIQUE (panel_fiber_id, strand_number);


--
-- Name: panel_fiber_strands panel_fiber_strands_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.panel_fiber_strands
    ADD CONSTRAINT panel_fiber_strands_pkey PRIMARY KEY (id);


--
-- Name: panel_fibers panel_fibers_panel_id_route_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.panel_fibers
    ADD CONSTRAINT panel_fibers_panel_id_route_id_key UNIQUE (panel_id, route_id);


--
-- Name: panel_fibers panel_fibers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.panel_fibers
    ADD CONSTRAINT panel_fibers_pkey PRIMARY KEY (id);


--
-- Name: patch_panels patch_panels_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patch_panels
    ADD CONSTRAINT patch_panels_pkey PRIMARY KEY (id);


--
-- Name: poles poles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.poles
    ADD CONSTRAINT poles_pkey PRIMARY KEY (id);


--
-- Name: routes routes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.routes
    ADD CONSTRAINT routes_pkey PRIMARY KEY (id);


--
-- Name: session session_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session
    ADD CONSTRAINT session_pkey PRIMARY KEY (sid);


--
-- Name: sfp_types sfp_types_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sfp_types
    ADD CONSTRAINT sfp_types_name_key UNIQUE (name);


--
-- Name: sfp_types sfp_types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sfp_types
    ADD CONSTRAINT sfp_types_pkey PRIMARY KEY (id);


--
-- Name: sites sites_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sites
    ADD CONSTRAINT sites_pkey PRIMARY KEY (id);


--
-- Name: splices splices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.splices
    ADD CONSTRAINT splices_pkey PRIMARY KEY (id);


--
-- Name: splitters splitters_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.splitters
    ADD CONSTRAINT splitters_pkey PRIMARY KEY (id);


--
-- Name: user_preferences user_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_preferences
    ADD CONSTRAINT user_preferences_pkey PRIMARY KEY (user_id);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: users users_username_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key UNIQUE (username);


--
-- Name: idx_closures_geom; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_closures_geom ON public.closures USING gist (geom);


--
-- Name: idx_poles_geom; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_poles_geom ON public.poles USING gist (geom);


--
-- Name: idx_routes_geom; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_routes_geom ON public.routes USING gist (geom);


--
-- Name: idx_session_expire; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_session_expire ON public.session USING btree (expire);


--
-- Name: closures closures_change; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER closures_change AFTER INSERT OR DELETE OR UPDATE ON public.closures FOR EACH ROW EXECUTE FUNCTION public.notify_map_change();


--
-- Name: poles poles_change; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER poles_change AFTER INSERT OR DELETE OR UPDATE ON public.poles FOR EACH ROW EXECUTE FUNCTION public.notify_map_change();


--
-- Name: routes routes_change; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER routes_change AFTER INSERT OR DELETE OR UPDATE ON public.routes FOR EACH ROW EXECUTE FUNCTION public.notify_map_change();


--
-- Name: sites sites_change; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sites_change AFTER INSERT OR DELETE OR UPDATE ON public.sites FOR EACH ROW EXECUTE FUNCTION public.notify_map_change();


--
-- Name: cables cables_closure_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cables
    ADD CONSTRAINT cables_closure_id_fkey FOREIGN KEY (closure_id) REFERENCES public.closures(id) ON DELETE CASCADE;


--
-- Name: cables cables_link_closure_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cables
    ADD CONSTRAINT cables_link_closure_id_fkey FOREIGN KEY (link_closure_id) REFERENCES public.closures(id) ON DELETE SET NULL;


--
-- Name: cables cables_route_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cables
    ADD CONSTRAINT cables_route_id_fkey FOREIGN KEY (route_id) REFERENCES public.routes(id) ON DELETE SET NULL;


--
-- Name: closures closures_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.closures
    ADD CONSTRAINT closures_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: closures closures_layer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.closures
    ADD CONSTRAINT closures_layer_id_fkey FOREIGN KEY (layer_id) REFERENCES public.layers(id) ON DELETE SET NULL;


--
-- Name: closures closures_pole_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.closures
    ADD CONSTRAINT closures_pole_id_fkey FOREIGN KEY (pole_id) REFERENCES public.poles(id) ON DELETE SET NULL;


--
-- Name: connections connections_a_panel_fiber_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connections
    ADD CONSTRAINT connections_a_panel_fiber_id_fkey FOREIGN KEY (a_panel_fiber_id) REFERENCES public.panel_fibers(id) ON DELETE CASCADE;


--
-- Name: connections connections_a_port_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connections
    ADD CONSTRAINT connections_a_port_id_fkey FOREIGN KEY (a_port_id) REFERENCES public.equipment_ports(id) ON DELETE CASCADE;


--
-- Name: connections connections_b_panel_fiber_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connections
    ADD CONSTRAINT connections_b_panel_fiber_id_fkey FOREIGN KEY (b_panel_fiber_id) REFERENCES public.panel_fibers(id) ON DELETE CASCADE;


--
-- Name: connections connections_b_port_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connections
    ADD CONSTRAINT connections_b_port_id_fkey FOREIGN KEY (b_port_id) REFERENCES public.equipment_ports(id) ON DELETE CASCADE;


--
-- Name: custom_field_values custom_field_values_field_def_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custom_field_values
    ADD CONSTRAINT custom_field_values_field_def_id_fkey FOREIGN KEY (field_def_id) REFERENCES public.custom_field_defs(id) ON DELETE CASCADE;


--
-- Name: equipment_card_assignments equipment_card_assignments_card_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipment_card_assignments
    ADD CONSTRAINT equipment_card_assignments_card_type_id_fkey FOREIGN KEY (card_type_id) REFERENCES public.card_types(id);


--
-- Name: equipment_card_assignments equipment_card_assignments_equipment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipment_card_assignments
    ADD CONSTRAINT equipment_card_assignments_equipment_id_fkey FOREIGN KEY (equipment_id) REFERENCES public.equipment(id) ON DELETE CASCADE;


--
-- Name: equipment_ports equipment_ports_equipment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipment_ports
    ADD CONSTRAINT equipment_ports_equipment_id_fkey FOREIGN KEY (equipment_id) REFERENCES public.equipment(id) ON DELETE CASCADE;


--
-- Name: equipment_ports equipment_ports_sfp_assignment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipment_ports
    ADD CONSTRAINT equipment_ports_sfp_assignment_id_fkey FOREIGN KEY (sfp_assignment_id) REFERENCES public.equipment_sfp_assignments(id) ON DELETE CASCADE;


--
-- Name: equipment_sfp_assignments equipment_sfp_assignments_equipment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipment_sfp_assignments
    ADD CONSTRAINT equipment_sfp_assignments_equipment_id_fkey FOREIGN KEY (equipment_id) REFERENCES public.equipment(id) ON DELETE CASCADE;


--
-- Name: equipment_sfp_assignments equipment_sfp_assignments_sfp_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipment_sfp_assignments
    ADD CONSTRAINT equipment_sfp_assignments_sfp_type_id_fkey FOREIGN KEY (sfp_type_id) REFERENCES public.sfp_types(id);


--
-- Name: equipment equipment_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipment
    ADD CONSTRAINT equipment_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE CASCADE;


--
-- Name: equipment equipment_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipment
    ADD CONSTRAINT equipment_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.equipment_templates(id) ON DELETE SET NULL;


--
-- Name: layers layers_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.layers
    ADD CONSTRAINT layers_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.layer_groups(id) ON DELETE CASCADE;


--
-- Name: panel_fiber_strands panel_fiber_strands_panel_fiber_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.panel_fiber_strands
    ADD CONSTRAINT panel_fiber_strands_panel_fiber_id_fkey FOREIGN KEY (panel_fiber_id) REFERENCES public.panel_fibers(id) ON DELETE CASCADE;


--
-- Name: panel_fibers panel_fibers_panel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.panel_fibers
    ADD CONSTRAINT panel_fibers_panel_id_fkey FOREIGN KEY (panel_id) REFERENCES public.patch_panels(id) ON DELETE CASCADE;


--
-- Name: panel_fibers panel_fibers_route_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.panel_fibers
    ADD CONSTRAINT panel_fibers_route_id_fkey FOREIGN KEY (route_id) REFERENCES public.routes(id) ON DELETE CASCADE;


--
-- Name: patch_panels patch_panels_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patch_panels
    ADD CONSTRAINT patch_panels_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE CASCADE;


--
-- Name: poles poles_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.poles
    ADD CONSTRAINT poles_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: poles poles_layer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.poles
    ADD CONSTRAINT poles_layer_id_fkey FOREIGN KEY (layer_id) REFERENCES public.layers(id) ON DELETE SET NULL;


--
-- Name: routes routes_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.routes
    ADD CONSTRAINT routes_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: routes routes_layer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.routes
    ADD CONSTRAINT routes_layer_id_fkey FOREIGN KEY (layer_id) REFERENCES public.layers(id) ON DELETE SET NULL;


--
-- Name: sites sites_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sites
    ADD CONSTRAINT sites_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: sites sites_layer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sites
    ADD CONSTRAINT sites_layer_id_fkey FOREIGN KEY (layer_id) REFERENCES public.layers(id) ON DELETE SET NULL;


--
-- Name: splices splices_closure_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.splices
    ADD CONSTRAINT splices_closure_id_fkey FOREIGN KEY (closure_id) REFERENCES public.closures(id) ON DELETE CASCADE;


--
-- Name: splices splices_from_cable_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.splices
    ADD CONSTRAINT splices_from_cable_id_fkey FOREIGN KEY (from_cable_id) REFERENCES public.cables(id) ON DELETE CASCADE;


--
-- Name: splices splices_to_cable_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.splices
    ADD CONSTRAINT splices_to_cable_id_fkey FOREIGN KEY (to_cable_id) REFERENCES public.cables(id) ON DELETE CASCADE;


--
-- Name: splitters splitters_closure_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.splitters
    ADD CONSTRAINT splitters_closure_id_fkey FOREIGN KEY (closure_id) REFERENCES public.closures(id) ON DELETE CASCADE;


--
-- Name: splitters splitters_input_cable_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.splitters
    ADD CONSTRAINT splitters_input_cable_id_fkey FOREIGN KEY (input_cable_id) REFERENCES public.cables(id) ON DELETE SET NULL;


--
-- Name: splitters splitters_output_cable_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.splitters
    ADD CONSTRAINT splitters_output_cable_id_fkey FOREIGN KEY (output_cable_id) REFERENCES public.cables(id) ON DELETE SET NULL;


--
-- Name: user_preferences user_preferences_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_preferences
    ADD CONSTRAINT user_preferences_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

\unrestrict JVCjzkcnEf525G6My9HTLu2gSOw6bQ7RUAstLbTAXDnRCqutayMfBCIcYr3vSRF

