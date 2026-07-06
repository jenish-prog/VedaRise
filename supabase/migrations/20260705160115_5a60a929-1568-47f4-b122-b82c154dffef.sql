
CREATE TYPE public.app_role AS ENUM ('admin', 'user');

CREATE TABLE public.user_roles (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users ON DELETE CASCADE,
  role app_role NOT NULL DEFAULT 'user',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, role)
);
GRANT SELECT ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read own roles" ON public.user_roles FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role);
$$;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'user') ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

CREATE TYPE public.draft_status AS ENUM ('pending', 'approved', 'rejected', 'posted', 'failed');

CREATE TABLE public.drafts (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  run_date DATE NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')::date,
  rank INT NOT NULL,
  title TEXT NOT NULL,
  source TEXT,
  url TEXT,
  summary TEXT,
  topic TEXT,
  image_url TEXT,
  image_path TEXT,
  caption TEXT,
  hashtags TEXT[] DEFAULT '{}',
  channels JSONB NOT NULL DEFAULT '{"linkedin":true,"x":true,"facebook":true,"instagram":true}'::jsonb,
  status draft_status NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_at TIMESTAMPTZ,
  approved_by UUID REFERENCES auth.users
);
CREATE INDEX drafts_run_date_idx ON public.drafts(run_date DESC, rank ASC);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.drafts TO authenticated;
GRANT ALL ON public.drafts TO service_role;
ALTER TABLE public.drafts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Auth users read drafts" ON public.drafts FOR SELECT TO authenticated USING (true);
CREATE POLICY "Auth users update drafts" ON public.drafts FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

CREATE TABLE public.post_results (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  draft_id UUID NOT NULL REFERENCES public.drafts(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  status TEXT NOT NULL,
  posted_url TEXT,
  error TEXT,
  posted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT ON public.post_results TO authenticated;
GRANT ALL ON public.post_results TO service_role;
ALTER TABLE public.post_results ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Auth users read results" ON public.post_results FOR SELECT TO authenticated USING (true);

CREATE OR REPLACE FUNCTION public.touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;
CREATE TRIGGER drafts_touch BEFORE UPDATE ON public.drafts FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
